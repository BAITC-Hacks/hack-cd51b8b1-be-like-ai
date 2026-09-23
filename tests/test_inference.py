from datetime import datetime, timezone
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from backend.config import Settings
from backend.inference import GenerationMonitor, TranscriptReferences
from backend.processing import LocalEngine, ProcessingError, apply_speaker_suggestions, materialize_extraction
from backend.schemas import Meeting, Segment, Speaker, SpeakerSuggestion
from backend.storage import Store
from backend.worker import Worker


def sample_meeting():
    chair = Speaker(label='voice_a', display_name='Спикер 1')
    respondent = Speaker(label='voice_b', display_name='Спикер 2')
    return Meeting(title='Оперативное совещание', created_at=datetime.now(timezone.utc),
        speakers=[chair, respondent], segments=[
            Segment(start=0, end=8, speaker_id=chair.id, text='Начнём с Батагус Нурлановны.'),
            Segment(start=9, end=20, speaker_id=respondent.id,
                    text='По химическому направлению за август. Подготовлю отчёт до пятницы.'),
        ])


def name_payload():
    return {'speakers': [{'speaker_id': 'S2', 'display_name': 'Батагус Нурлановна',
                          'evidence_segment_ids': ['T1', 'T2']}]}


def task_payload():
    return {**name_payload(), 'summary': {'overview': 'Обсуждён отчёт'}, 'tasks': [{
        'title': 'Подготовить отчёт', 'assignee_name': 'Батагус Нурлановна',
        'assignee_type': 'person', 'assignee_speaker_id': 'S2',
        'deadline_text': 'до пятницы', 'deadline_kind': 'relative', 'evidence_segment_ids': ['T2'],
        'evidence_quote': 'Подготовлю отчёт до пятницы.',
    }]}


def audit_payload():
    return {'checked_segment_ids': ['T1', 'T2'], 'additions': [], 'corrections': [], 'removals': []}


def test_short_model_references_roundtrip_without_changing_public_ids():
    meeting = sample_meeting()
    refs = TranscriptReferences(meeting)
    assert meeting.id not in json.dumps(refs.data)
    assert meeting.segments[0].id not in json.dumps(refs.data)
    assert refs.data['segments'][1]['speaker_id'] == 'S2'
    result = refs.decode_extraction(task_payload())
    materialize_extraction(meeting, result)
    assert meeting.tasks[0].assignee_speaker_id == meeting.speakers[1].id
    assert meeting.tasks[0].evidence_segment_ids == [meeting.segments[1].id]
    assert meeting.tasks[0].due_date is None
    assert meeting.speakers[0].identification == 'unknown'
    assert meeting.speakers[1].display_name == 'Батагус Нурлановна'
    assert meeting.speakers[1].identification == 'suggested'
    assert meeting.speakers[1].evidence_segment_ids == [s.id for s in meeting.segments]


@pytest.mark.parametrize('reference_kind', ['task_source', 'task_speaker', 'speaker_source', 'speaker_id'])
def test_invented_model_references_are_rejected(reference_kind):
    payload = task_payload()
    if reference_kind == 'task_source':
        payload['tasks'][0]['evidence_segment_ids'] = ['T999']
    elif reference_kind == 'task_speaker':
        payload['tasks'][0]['assignee_speaker_id'] = 'S999'
    elif reference_kind == 'speaker_source':
        payload['speakers'][0]['evidence_segment_ids'] = ['T999']
    else:
        payload['speakers'][0]['speaker_id'] = 'S999'
    with pytest.raises(ValueError):
        TranscriptReferences(sample_meeting()).decode_extraction(payload)


def test_address_without_the_respondents_utterance_cannot_identify_them():
    meeting = sample_meeting()
    suggestion = SpeakerSuggestion(speaker_id=meeting.speakers[1].id, display_name='Батагус Нурлановна',
                                   evidence_segment_ids=[meeting.segments[0].id])
    with pytest.raises(ValueError):
        apply_speaker_suggestions(meeting, [suggestion])
    assert meeting.speakers[1].identification == 'unknown'


def test_human_confirmed_name_is_never_overwritten_by_model():
    meeting = sample_meeting()
    meeting.speakers[1].display_name = 'Имя, исправленное секретарём'
    meeting.speakers[1].identification = 'confirmed'
    suggestions = TranscriptReferences(meeting).decode_speakers(name_payload())
    apply_speaker_suggestions(meeting, suggestions)
    assert meeting.speakers[1].display_name == 'Имя, исправленное секретарём'
    assert meeting.speakers[1].identification == 'confirmed'


def test_generic_voice_label_is_not_an_identified_person():
    meeting = sample_meeting()
    apply_speaker_suggestions(meeting, [SpeakerSuggestion(speaker_id=meeting.speakers[1].id,
        display_name='Спикер 2', evidence_segment_ids=[meeting.segments[1].id])])
    assert meeting.speakers[1].identification == 'unknown'


def test_one_bad_name_does_not_discard_other_grounded_suggestions():
    meeting = sample_meeting()
    payload = name_payload()
    payload['speakers'].append({'speaker_id': 'S1', 'display_name': 'Неверное имя', 'evidence_segment_ids': ['T2']})
    speakers = ScriptedEngine([json.dumps(payload)]).identify_speakers(meeting)
    assert speakers[1].display_name == 'Батагус Нурлановна'
    assert speakers[0].identification == 'unknown'


def test_generation_monitor_reports_real_token_count_and_stops_on_deadline(monkeypatch):
    now = [100.]
    monkeypatch.setattr('backend.inference.time.monotonic', lambda: now[0])
    logger = Mock()
    monitor = GenerationMonitor(input_tokens=50, deadline=125, log=logger, label='test')
    now[0] = 111.
    assert monitor(SimpleNamespace(shape=(1, 70))) is False
    assert logger.info.call_args.args[2:4] == (20, 11.)
    now[0] = 126.
    assert monitor(SimpleNamespace(shape=(1, 80))) is True
    assert monitor.timed_out


class ScriptedEngine(LocalEngine):
    """Test only: exercise orchestration without installing/loading GPU models."""
    def __init__(self, responses):
        self.settings = Settings()
        self.responses = iter(responses)
        self.calls = []

    def _ensure_llm(self):
        pass

    def _generate(self, messages, **kwargs):
        self.calls.append(kwargs)
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


def test_json_repair_shares_one_time_budget_and_preserves_caller_meeting():
    meeting = sample_meeting()
    engine = ScriptedEngine(['not JSON', json.dumps(task_payload()), json.dumps(audit_payload())])
    result = engine.extract(meeting)
    assert len(result.tasks) == 1 and meeting.tasks == []
    assert engine.calls[0]['deadline'] == engine.calls[1]['deadline']


def test_timeout_is_reported_without_starting_another_generation():
    engine = ScriptedEngine([ProcessingError('EXTRACTION_TIMEOUT', 'Timeout')])
    with pytest.raises(ProcessingError) as error:
        engine.extract(sample_meeting())
    assert error.value.code == 'EXTRACTION_TIMEOUT'
    assert len(engine.calls) == 1


@pytest.mark.parametrize('response', [
    'not JSON',
    json.dumps({'speakers': [{'speaker_id': 'S99', 'display_name': 'Неизвестный', 'evidence_segment_ids': ['T1']}]}),
    ProcessingError('EXTRACTION_TIMEOUT', 'Timeout'),
])
def test_optional_naming_failure_keeps_unidentified_voices(response):
    meeting = sample_meeting()
    speakers = ScriptedEngine([response]).identify_speakers(meeting)
    assert [s.identification for s in speakers] == ['unknown', 'unknown']


def test_worker_persists_names_and_transcript_before_task_extraction(tmp_path):
    store = Store(tmp_path / 'meetings.sqlite3')
    meeting = Meeting(title='Test', created_at=datetime.now(timezone.utc))
    store.create(meeting, tmp_path / 'audio.wav')

    class Engine:
        def decode(self, path):
            return path, 20.

        def transcribe(self, path):
            return [{'start': 0., 'end': 8., 'text': 'Начнём с Батагус Нурлановны.'},
                    {'start': 9., 'end': 20., 'text': 'По химическому направлению за август.'}]

        def diarize(self, path):
            return [(0., 8., 'A'), (9., 20., 'B')]

        def identify_speakers(self, current):
            suggestions = TranscriptReferences(current).decode_speakers(name_payload())
            apply_speaker_suggestions(current, suggestions)
            return current.speakers

        def extract(self, current, on_partial=None):
            stored = store.get(current.id)
            assert stored.stage == 'extract' and stored.status == 'processing'
            assert stored.speakers[1].display_name == 'Батагус Нурлановна'
            assert len(stored.segments) == 2
            return current

    Worker(store, Engine()).process(meeting.id)
    assert store.get(meeting.id).status == 'ready'


def test_retry_uses_cached_transcript_without_loading_asr_or_diarization(tmp_path):
    from scripts.retry_extraction import choose_meeting

    store = Store(tmp_path / 'meetings.sqlite3')
    meeting = sample_meeting()
    meeting.status, meeting.stage = 'failed', 'extract'
    store.create(meeting, tmp_path / 'audio.wav')
    assert choose_meeting(store).id == meeting.id
    engine = ScriptedEngine([json.dumps(name_payload()), json.dumps(task_payload()), json.dumps(audit_payload())])
    Worker(store, engine).extract_saved(meeting.id)
    result = store.get(meeting.id)
    assert result.status == 'ready' and result.error is None
    assert len(result.tasks) == 1
    assert [s.id for s in result.segments] == [s.id for s in meeting.segments]
    assert result.speakers[1].display_name == 'Батагус Нурлановна'
    with pytest.raises(ValueError):
        choose_meeting(store)
    with pytest.raises(ValueError):
        choose_meeting(store, meeting.id)
