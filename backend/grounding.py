"""Ground model claims in cited utterances; never use a reference protocol as input."""
from datetime import datetime, timezone
import re
import unicodedata

from .deadlines import MONTHS, resolve_deadline


def canonical(text):
    text = ' '.join(unicodedata.normalize('NFKC', text).casefold().replace('ё', 'е').split())
    # Word timestamp alignment can leave a space before punctuation ("Иванов .").
    # Normalize that formatting only after letters; never reinterpret numeric separators.
    return re.sub(r'(?<=[^\W\d_])\s+([,.;:!?])', r'\1', text)


def quote_sources(quote, segments, *, unique=False):
    parts, offsets, cursor = [], [], 0
    for segment in segments:
        part = canonical(segment.text)
        parts.append(part)
        offsets.append((cursor, cursor + len(part), segment.id))
        cursor += len(part) + 1
    needle = canonical(quote)
    if not needle:
        return []
    haystack = ' '.join(parts)
    start = haystack.find(needle)
    if start < 0:
        return []
    if unique and haystack.find(needle, start + 1) >= 0:
        return []
    end = start + len(needle)
    return [sid for left, right, sid in offsets if left < end and right > start]


def _calendar_key(text):
    # Restrict repair to an explicit calendar day. "На неделе" and "до недели" are NOT equivalent.
    if not re.search('|'.join(MONTHS), canonical(text)):
        return None
    due, kind, _ = resolve_deadline(text, 'date', datetime(2000, 1, 1, tzinfo=timezone.utc), 'UTC')
    if due is None or kind != 'date':
        return None
    year = re.search(r'\b20\d{2}\b', text)
    return due.month, due.day, year.group() if year else None


def calendar_quotes(text):
    months = '|'.join(re.escape(root) + r'\w*' for root in MONTHS)
    day = r'(?:\d{1,2}|(?:двадцать|тридцать)\s+[а-яё]+|[а-яё]+)'
    pattern = rf'(?<!\w)(?:(?:к|до|не\s+позднее)\s+)?{day}\s+(?:{months})(?:\s+20\d{{2}}(?:\s*года)?)?'
    return [m.group() for m in re.finditer(pattern, text, flags=re.I)]


def ground_task(task, meeting, *, require_quote=False):
    """Copy before repairs; relocate only exact, unambiguous transcript quotations."""
    task = task.model_copy(deep=True)
    index = {segment.id: i for i, segment in enumerate(meeting.segments)}
    if not task.evidence_segment_ids or any(sid not in index for sid in task.evidence_segment_ids):
        raise ValueError('Unknown or missing task source')
    selected = {index[sid] for sid in task.evidence_segment_ids}
    def continuous_sources(quote, positions):
        groups = []
        for position in sorted(positions):
            if not groups or position != groups[-1][-1] + 1:
                groups.append([])
            groups[-1].append(position)
        for group in groups:
            sources = quote_sources(quote, [meeting.segments[i] for i in group])
            if sources:
                return sources
        return []
    neighbours = sorted({j for i in selected for j in range(max(0, i - 1), min(len(index), i + 2))})
    neighbour_segments = [meeting.segments[i] for i in neighbours]
    if require_quote and not task.evidence_quote:
        raise ValueError('Task needs a verbatim quote of the assigned/accepted action')
    if task.evidence_quote:
        sources = continuous_sources(task.evidence_quote, selected) or continuous_sources(task.evidence_quote, neighbours)
        if not sources:
            sources = quote_sources(task.evidence_quote, meeting.segments, unique=True)
        if not sources:
            raise ValueError(f'Task "{task.title}": evidence_quote must be an exact continuous transcript quote; invented or ambiguous quote')
        selected.update(index[sid] for sid in sources)
        neighbours = sorted({j for i in selected for j in range(max(0, i - 1), min(len(index), i + 2))})
        neighbour_segments = [meeting.segments[i] for i in neighbours]
        # An explicit address in the validated action quote outranks a model guess
        # based on the voice label or the colleague mentioned later in the sentence.
        name = r'[А-ЯЁӘҒҚҢӨҰҮҺІA-Z][а-яёәғқңөұүһіa-z-]+'
        imperative = r'свяжитесь|согласуйте|подготовьте|проведите|представьте|проверьте|запросите|организуйте|разберитесь'
        addressed = {m.group('name') for m in re.finditer(
            rf'\b(?P<name>{name}(?:\s+{name}){{1,2}}),\s*(?:пожалуйста,?\s+)?(?:{imperative})\b', task.evidence_quote)}
        if len(addressed) == 1:
            explicit = addressed.pop()
            if canonical(explicit) != canonical(task.assignee_name or ''):
                task.assignee_name, task.assignee_type, task.assignee_speaker_id = explicit, 'person', None
                task.review_reasons.append('Исполнитель восстановлен по явному обращению в цитате; проверьте написание имени')
    if task.deadline_text:
        sources = continuous_sources(task.deadline_text, selected) or continuous_sources(task.deadline_text, neighbours)
        if not sources and task.deadline_kind not in ('event', 'conflicting'):
            key = _calendar_key(task.deadline_text)
            # Restore "до 15 октября" -> actual "К 15 октября". Never synthesize a year/date.
            if key:
                candidates = {quote for quote in calendar_quotes(' '.join(s.text for s in neighbour_segments))
                              if _calendar_key(quote) == key}
                if len(candidates) == 1:
                    quote = candidates.pop()
                    sources = quote_sources(quote, neighbour_segments)
                    if sources:
                        task.deadline_text = quote
        if sources:
            selected.update(index[sid] for sid in sources)
    task.evidence_segment_ids = [meeting.segments[i].id for i in sorted(selected)]
    return task


def task_diagnostics(task, meeting):
    source = [s for s in meeting.segments if s.id in task.evidence_segment_ids]
    problems = []
    if task.deadline_text and not quote_sources(task.deadline_text, source):
        problems.append('deadline_text не является дословной цитатой; найдите исходный срок и его реплики')
    if not task.assignee_name:
        problems.append('Исполнитель не установлен: проверьте обращение перед поручением и ответ после него')
    return problems


def merge_exact_tasks(tasks):
    """Only exact semantic fields; sharing a speaker/source is not a duplicate criterion."""
    result, seen = [], {}
    for task in tasks:
        key = (canonical(task.title), canonical(task.assignee_name or ''), canonical(task.deadline_text or ''))
        if key in seen:
            existing = seen[key]
            existing.evidence_segment_ids = list(dict.fromkeys(existing.evidence_segment_ids + task.evidence_segment_ids))
            if len(task.description) > len(existing.description):
                existing.description = task.description
            existing.review_reasons = list(dict.fromkeys(existing.review_reasons + task.review_reasons))
        else:
            item = task.model_copy(deep=True)
            seen[key] = item
            result.append(item)
    return result
