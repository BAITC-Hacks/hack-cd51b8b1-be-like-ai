from datetime import datetime, timezone
import json

import pytest

from backend.extraction_audit import apply_audit
from backend.grounding import ground_task
from backend.inference import TranscriptReferences
from backend.processing import ProcessingError, align_words, materialize_extraction
from backend.schemas import ExtractedTask, Extraction, Meeting, Segment, Speaker
from test_inference import ScriptedEngine


def meeting_from_texts(*texts):
    speaker = Speaker(label='VOICE_1', display_name='Спикер 1')
    return Meeting(title='Тест качества', created_at=datetime.now(timezone.utc),
        started_at=datetime.fromisoformat('2026-09-23T13:00:00+05:00'), speakers=[speaker],
        segments=[Segment(start=i * 10, end=(i + 1) * 10, text=text, speaker_id=speaker.id)
                  for i, text in enumerate(texts)])


def task(meeting, deadline, quote, ids=None):
    return ExtractedTask(title='Представить отчёт', deadline_text=deadline, deadline_kind='date',
        evidence_quote=quote, evidence_segment_ids=ids or [meeting.segments[0].id])


def test_deadline_split_between_adjacent_utterances_restores_source_and_date():
    meeting = meeting_from_texts('Представьте сводный отчёт. Срок к', '20 октября. Договорились.')
    extracted = Extraction(summary={}, tasks=[task(meeting, 'до 20 октября', 'Представьте сводный отчёт.')])
    materialize_extraction(meeting, extracted)
    result = meeting.tasks[0]
    assert result.deadline_text == 'к 20 октября'
    assert result.due_date.isoformat() == '2026-10-20'
    assert result.evidence_segment_ids == [s.id for s in meeting.segments]


def test_calendar_preposition_is_restored_to_actual_quote():
    meeting = meeting_from_texts('К 15 октября жду сводный отчёт по каждой площадке отдельно.')
    result = ground_task(task(meeting, 'до 15 октября', 'жду сводный отчёт по каждой площадке отдельно.'), meeting)
    assert result.deadline_text == 'К 15 октября'


def test_missing_year_cannot_be_fabricated_by_quote_repair():
    meeting = meeting_from_texts('Представьте отчёт к 20 октября.')
    result = ground_task(task(meeting, 'до 20 октября 2027', 'Представьте отчёт к 20 октября.'), meeting)
    materialize_extraction(meeting, Extraction(summary={}, tasks=[result]))
    assert meeting.tasks[0].due_date is None


def test_next_week_and_before_next_week_are_not_treated_as_equivalent():
    meeting = meeting_from_texts('На следующей неделе проведите инструктаж с реальной проверкой знаний.')
    wrong = task(meeting, 'до следующей недели', 'проведите инструктаж с реальной проверкой знаний.')
    wrong.deadline_kind = 'relative'
    result = ground_task(wrong, meeting)
    assert result.deadline_text == 'до следующей недели'
    materialize_extraction(meeting, Extraction(summary={}, tasks=[result]))
    assert meeting.tasks[0].due_date is None
    assert any('не совпадает' in reason for reason in meeting.tasks[0].review_reasons)


def test_invented_action_quote_is_rejected():
    meeting = meeting_from_texts('Обсудили идею обновления оборудования. Решение не принято.')
    with pytest.raises(ValueError):
        ground_task(task(meeting, None, 'Немедленно заменить оборудование.'), meeting, require_quote=True)


def test_unique_exact_quote_repairs_wrong_reference_across_two_later_segments():
    meeting = meeting_from_texts('Первое. Обсудить закупки.', 'Второе. Представьте отчёт. Срок к', '20 октября.')
    result = ground_task(task(meeting, 'до 20 октября', 'Представьте отчёт. Срок к 20 октября.'), meeting, require_quote=True)
    assert result.deadline_text == 'к 20 октября'
    assert set(s.id for s in meeting.segments[1:]) <= set(result.evidence_segment_ids)


def test_ambiguous_remote_quote_cannot_repair_wrong_reference():
    meeting = meeting_from_texts('Обсудим.', 'Далее.', 'Подготовьте отчёт.', 'Другое.', 'Подготовьте отчёт.')
    with pytest.raises(ValueError):
        ground_task(task(meeting, None, 'Подготовьте отчёт.'), meeting, require_quote=True)


def test_quote_cannot_bridge_omitted_non_adjacent_text():
    meeting = meeting_from_texts('Подготовьте', 'эскиз.', 'Другое обсуждение.', 'Новый пункт.', 'отчёт к пятнице.')
    with pytest.raises(ValueError):
        ground_task(task(meeting, None, 'Подготовьте отчёт к пятнице.',
                        [meeting.segments[0].id, meeting.segments[-1].id]), meeting, require_quote=True)


def test_alignment_space_before_sentence_punctuation_is_not_a_changed_quote():
    text = 'Подготовить финансовое решение. Ответственный Тимур Балатович . Срок до 30 сентября.'
    meeting = meeting_from_texts(text)
    result = ground_task(task(meeting, 'до 30 сентября', text.replace('Балатович .', 'Балатович.')), meeting, require_quote=True)
    assert result.evidence_segment_ids == [meeting.segments[0].id]
    with pytest.raises(ValueError):
        ground_task(task(meeting, None, text.replace('Балатович', 'Булатович')), meeting, require_quote=True)


def test_audit_windows_cover_all_utterances_with_neighbour_context():
    meeting = meeting_from_texts(*['Реплика ' + str(i) + ' ' + 'текст ' * 15 for i in range(10)])
    windows = list(TranscriptReferences(meeting).windows(250))
    primary = [sid for window in windows for sid in window['primary_segment_ids']]
    assert primary == [f'T{i}' for i in range(1, 11)]
    assert 'T3' in [s['id'] for s in windows[0]['segments']]
    assert 'T1' in [s['id'] for s in windows[1]['segments']]


def obligation_payload(quote, source, title='Разобраться с подрядчиком'):
    return {'title': title, 'description': 'Выяснить причину срыва графика и доложить лично.',
            'assignee_name': 'Айдана', 'deadline_text': 'до пятницы', 'deadline_kind': 'relative',
            'evidence_segment_ids': [source], 'evidence_quote': quote}


def test_independent_audit_recovers_obligation_missed_by_first_pass():
    text = 'Айдана, до пятницы разберитесь с подрядчиком, почему сорвали график, и доложите мне лично.'
    meeting = meeting_from_texts(text, 'Хорошо, сделаю.')
    first = {'summary': {'overview': 'Обсуждён подрядчик'}, 'tasks': [], 'speakers': []}
    audit = {'checked_segment_ids': ['T1', 'T2'], 'additions': [obligation_payload(text, 'T1')],
             'corrections': [], 'removals': []}
    partials = []
    result = ScriptedEngine([json.dumps(first), json.dumps(audit)]).extract(meeting, on_partial=partials.append)
    assert len(result.tasks) == 1
    assert result.tasks[0].assignee_name == 'Айдана'
    assert 'доложить лично' in result.tasks[0].description
    assert result.extraction_checked_segments == 2
    assert partials[0].tasks == [] and partials[-1].tasks[0].needs_review
    assert result.summary.decisions and 'Разобраться' in result.summary.decisions[0]


def test_quote_repair_is_small_and_keeps_the_same_generation_budget():
    text = 'Алия, подготовьте финансовое решение по проекту к пятнице.'
    meeting = meeting_from_texts(text)
    initial = {'summary': {}, 'tasks': [{'title': 'Подготовить финансовое решение',
        'evidence_quote': 'Алея, подготовьте финансовое решение по проекту к пятнице.', 'evidence_segment_ids': ['T1']}], 'speakers': []}
    repair = {'evidence_quote': 'подготовьте финансовое решение по проекту к пятнице.', 'evidence_segment_ids': ['T1']}
    audit = {'checked_segment_ids': ['T1'], 'additions': [], 'corrections': [], 'removals': []}
    engine = ScriptedEngine([json.dumps(initial), json.dumps(repair), json.dumps(audit)])
    result = engine.extract(meeting)
    assert len(result.tasks) == 1 and result.tasks[0].evidence_quote == repair['evidence_quote']
    assert engine.calls[1]['max_tokens'] == 500
    assert len({call['deadline'] for call in engine.calls}) == 1


def test_audit_quote_uses_the_same_exact_repair_as_the_draft():
    text = 'Алия, подготовьте финансовое решение по проекту к пятнице.'
    meeting = meeting_from_texts(text)
    initial = {'summary': {}, 'tasks': [], 'speakers': []}
    audit = {'checked_segment_ids': ['T1'], 'additions': [{'title': 'Подготовить финансовое решение',
        'evidence_quote': text.replace('Алия', 'Алея'), 'evidence_segment_ids': ['T1']}], 'corrections': [], 'removals': []}
    repair = {'evidence_quote': 'подготовьте финансовое решение по проекту к пятнице.', 'evidence_segment_ids': ['T1']}
    engine = ScriptedEngine([json.dumps(initial), json.dumps(audit), json.dumps(repair)])
    result = engine.extract(meeting)
    assert result.extraction_checked_segments == 1
    assert result.tasks[0].evidence_quote == repair['evidence_quote']


def test_incomplete_audit_never_reports_completed_coverage():
    meeting = meeting_from_texts('Айдана, подготовьте отчёт.', 'Срок до пятницы.')
    first = {'summary': {}, 'tasks': [], 'speakers': []}
    audit = {'checked_segment_ids': ['T1'], 'additions': [], 'corrections': [], 'removals': []}
    partials = []
    engine = ScriptedEngine([json.dumps(first), json.dumps(audit), json.dumps(audit)])
    with pytest.raises(ProcessingError) as exc:
        engine.extract(meeting, on_partial=partials.append)
    assert exc.value.code == 'COVERAGE_CHECK_FAILED'
    assert partials[-1].extraction_checked_segments == 0


def test_audit_may_also_check_visible_context_without_inflating_primary_coverage():
    meeting = meeting_from_texts('Первое обсуждение.', 'Второе обсуждение.', 'Третье обсуждение.', 'Четвёртое обсуждение.')
    refs = TranscriptReferences(meeting)
    window = next(refs.windows(10, context_segments=1))
    payload = {'checked_segment_ids': ['T1', 'T2'], 'additions': [], 'corrections': [], 'removals': []}
    apply_audit(Extraction(summary={}, tasks=[]), payload, refs, meeting, window)
    payload['checked_segment_ids'].append('T4')
    with pytest.raises(ValueError):
        apply_audit(Extraction(summary={}, tasks=[]), payload, refs, meeting, window)


def test_audit_correction_preserves_completion_criteria():
    text = 'Нурлан, на следующей неделе проведите инструктаж на всех площадках с реальной проверкой знаний.'
    meeting = meeting_from_texts(text)
    refs = TranscriptReferences(meeting)
    extracted = Extraction(summary={}, tasks=[ExtractedTask(title='Провести инструктаж',
        deadline_text='до следующей недели', deadline_kind='relative', evidence_quote=text,
        evidence_segment_ids=[meeting.segments[0].id])])
    corrected = {'title': 'Провести внеплановый инструктаж',
                 'description': 'Провести инструктаж на всех площадках с реальной проверкой знаний.',
                 'deadline_text': 'на следующей неделе', 'deadline_kind': 'relative',
                 'evidence_quote': text, 'evidence_segment_ids': ['T1']}
    payload = {'checked_segment_ids': ['T1'], 'additions': [],
               'corrections': [{'task_id': 'C1', 'task': corrected}], 'removals': []}
    result = apply_audit(extracted, payload, refs, meeting, next(refs.windows()))
    assert result.tasks[0].deadline_text == 'на следующей неделе'
    assert 'проверкой знаний' in result.tasks[0].description
    assert extracted.tasks[0].deadline_text == 'до следующей недели'


def test_point_timestamps_use_unique_active_voice_without_creating_unknown_fragments():
    speakers, segments = align_words([{'start': 0., 'end': 2., 'text': 'Тимур Болатович', 'words': [
        {'start': 0., 'end': 1., 'word': 'Тимур'}, {'start': 1., 'end': 1., 'word': ' Болатович'}]}], [(0., 2., 'A')])
    assert len(segments) == 1 and segments[0].speaker_id == speakers[0].id
    assert segments[0].text == 'Тимур Болатович' and segments[0].needs_review
