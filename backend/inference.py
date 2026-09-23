"""Small model-facing identifiers and generation monitoring; no GPU imports."""
import time

from .schemas import Extraction, SpeakerIdentification


class TranscriptReferences:
    def __init__(self, meeting):
        self.speakers = {f'S{i + 1}': s.id for i, s in enumerate(meeting.speakers)}
        self.segments = {f'T{i + 1}': s.id for i, s in enumerate(meeting.segments)}
        speaker_aliases = {value: key for key, value in self.speakers.items()}
        self.data = {
            'meeting_title': meeting.title,
            'speakers': [{'id': alias, 'display_name': speaker.display_name,
                          'identification': speaker.identification}
                         for alias, speaker in zip(self.speakers, meeting.speakers)],
            'segments': [{'id': alias, 'speaker_id': speaker_aliases.get(segment.speaker_id),
                          'start': segment.start, 'end': segment.end, 'text': segment.text,
                          'needs_review': segment.needs_review}
                         for alias, segment in zip(self.segments, meeting.segments)],
        }

    @staticmethod
    def _lookup(mapping, reference):
        try:
            return mapping[reference]
        except KeyError:
            raise ValueError('Unknown model source reference') from None

    def _speaker(self, suggestion):
        return suggestion.model_copy(update={
            'speaker_id': self._lookup(self.speakers, suggestion.speaker_id),
            'evidence_segment_ids': [self._lookup(self.segments, sid)
                                     for sid in suggestion.evidence_segment_ids],
        })

    def decode_speakers(self, payload):
        result = SpeakerIdentification.model_validate(payload)
        return [self._speaker(s) for s in result.speakers]

    def decode_extraction(self, payload):
        result = Extraction.model_validate(payload)
        result.speakers = [self._speaker(s) for s in result.speakers]
        for task in result.tasks:
            task.evidence_segment_ids = [self._lookup(self.segments, sid) for sid in task.evidence_segment_ids]
            if task.assignee_speaker_id is not None:
                task.assignee_speaker_id = self._lookup(self.speakers, task.assignee_speaker_id)
        return result

    def decode_task(self, task):
        return self.decode_extraction({'summary': {}, 'tasks': [task.model_dump()]}).tasks[0]

    def encode_task(self, task, task_id):
        speakers = {value: key for key, value in self.speakers.items()}
        segments = {value: key for key, value in self.segments.items()}
        result = task.model_dump()
        result['evidence_segment_ids'] = [segments[sid] for sid in task.evidence_segment_ids]
        result['assignee_speaker_id'] = speakers.get(task.assignee_speaker_id)
        return {'task_id': task_id, **result}

    def windows(self, max_chars=6500, context_segments=2):
        """Every utterance is primary once; neighbouring utterances provide context."""
        segments = self.data['segments']
        start = 0
        while start < len(segments):
            end, size = start, 0
            while end < len(segments) and (end == start or size + len(segments[end]['text']) <= max_chars):
                size += len(segments[end]['text'])
                end += 1
            yield {
                'primary_segment_ids': [s['id'] for s in segments[start:end]],
                'segments': segments[max(0, start - context_segments):min(len(segments), end + context_segments)],
            }
            start = end


class GenerationMonitor:
    """Transformers stopping criterion. Deadline checked after each generation step."""
    def __init__(self, input_tokens, deadline, log, label):
        self.input_tokens, self.deadline, self.log, self.label = input_tokens, deadline, log, label
        self.started = self.last_log = time.monotonic()
        self.timed_out = False

    def __call__(self, input_ids, scores=None, **kwargs):
        now = time.monotonic()
        generated = input_ids.shape[-1] - self.input_tokens
        self.timed_out = now >= self.deadline
        if now - self.last_log >= 10 or self.timed_out:
            self.log.info('LLM %s: generated=%d tokens elapsed=%.1fs timeout=%s',
                          self.label, generated, now - self.started, self.timed_out)
            self.last_log = now
        return self.timed_out
