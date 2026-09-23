"""Real GPU evaluation against a saved meeting; preserves the original by default."""
import argparse
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.config import Settings
from backend.exports import export_pdf, export_docx
from backend.processing import LocalEngine, align_words, materialize_extraction
from backend.inference import TranscriptReferences
from backend.schemas import ExtractedTask, Extraction, Meeting, new_id
from backend.storage import Store


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--meeting', required=True)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    input_mode = parser.add_mutually_exclusive_group()
    input_mode.add_argument('--retranscribe', action='store_true')
    input_mode.add_argument('--transcript-json', type=Path, help='Reuse transcript.json from an earlier run of the same meeting')
    parser.add_argument('--draft-json', type=Path, help='Reuse a saved draft; run its grounding and all coverage audits again')
    parser.add_argument('--consolidate-only', action='store_true', help='Recheck duplicates in a fully audited saved result; not a full-pipeline benchmark')
    parser.add_argument('--save-as-new', action='store_true')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    settings = Settings(data_dir=args.data_dir, model_dir=args.model_dir)
    store = Store(args.data_dir / 'meetings.sqlite3')
    original = store.get(args.meeting)
    meeting = Meeting.model_validate_json(args.transcript_json.read_text(encoding='utf-8')) if args.transcript_json else original.model_copy(deep=True)
    if meeting.id != original.id:
        raise SystemExit('Cached transcript belongs to a different meeting')
    if args.consolidate_only:
        if not args.transcript_json or args.draft_json or meeting.status != 'ready' or meeting.extraction_checked_segments != len(meeting.segments):
            raise SystemExit('Consolidation-only needs a ready, fully audited --transcript-json and no draft')
    else:
        meeting.tasks = []
        meeting.extraction_checked_segments = 0
    (args.output_dir / 'before.json').write_text(original.model_dump_json(indent=2), encoding='utf-8')
    draft = Meeting.model_validate_json(args.draft_json.read_text(encoding='utf-8')) if args.draft_json else None
    if draft and (draft.id != meeting.id or [(s.id, s.text) for s in draft.segments] != [(s.id, s.text) for s in meeting.segments]):
        raise SystemExit('Draft and transcript must belong to the same exact transcription')

    class TracedEngine(LocalEngine):
        sequence = 0

        def _generate(self, messages, **kwargs):
            self.sequence += 1
            # Traces stay in the private output directory, never in server console logs.
            if draft and kwargs['label'].startswith('extract ') and kwargs['label'].endswith('attempt=1'):
                refs = TranscriptReferences(meeting)
                tasks = []
                for task in draft.tasks:
                    item = ExtractedTask.model_validate({k: v for k, v in task.model_dump().items() if k in ExtractedTask.model_fields})
                    item.review_reasons = [r for r in item.review_reasons if r != 'Проверка полноты поручений ещё не завершена']
                    data = refs.encode_task(item, 'cached')
                    data.pop('task_id')
                    tasks.append(data)
                answer = json.dumps({'summary': draft.summary.model_dump(), 'tasks': tasks, 'speakers': []}, ensure_ascii=False)
                logging.info('Using saved draft; grounding and all coverage windows will run again')
            else:
                answer = super()._generate(messages, **kwargs)
            (args.output_dir / f'model-{self.sequence:02}.txt').write_text(answer, encoding='utf-8')
            return answer

    started = time.monotonic()
    engine = TracedEngine(settings)
    if args.retranscribe:
        wav, meeting.duration_seconds = engine.decode(store.media_path(original.id))
        asr = engine.transcribe(wav)
        turns = engine.diarize(wav)
        meeting.speakers, meeting.segments = align_words(asr, turns)
    (args.output_dir / 'transcript.json').write_text(meeting.model_dump_json(indent=2), encoding='utf-8')
    # Cached experiments must not feed earlier model guesses back as identity evidence.
    for i, speaker in enumerate(meeting.speakers, 1):
        if speaker.identification != 'confirmed':
            speaker.display_name = f'Спикер {i}'
            speaker.identification = 'unknown'
            speaker.evidence_segment_ids = []
    meeting.speakers = engine.identify_speakers(meeting)
    def partial(result):
        result.status, result.stage, result.progress = 'processing', 'extract', None
        (args.output_dir / 'partial.json').write_text(result.model_dump_json(indent=2), encoding='utf-8')
    if args.consolidate_only:
        extraction = Extraction(summary=meeting.summary, tasks=[ExtractedTask.model_validate(
            {k: v for k, v in task.model_dump().items() if k in ExtractedTask.model_fields}) for task in meeting.tasks])
        extraction = engine.consolidate(extraction, meeting, time.monotonic() + settings.llm_timeout_seconds)
        extraction.summary.decisions = [f'{t.title}. Ответственный: {t.assignee_name or "не установлен"}. Срок: {t.deadline_text or "не указан"}.' for t in extraction.tasks]
        materialize_extraction(meeting, extraction)
        result = meeting
    else:
        result = engine.extract(meeting, on_partial=partial)
    result.status, result.stage, result.progress, result.error = 'ready', 'complete', 100., None
    if args.save_as_new:
        result.id, result.created_at = new_id(), datetime.now(timezone.utc)
        result.title = original.title[:260] + ' — проверка качества'
        store.create(result, store.media_path(original.id))
    (args.output_dir / 'result.json').write_text(result.model_dump_json(indent=2), encoding='utf-8')
    (args.output_dir / 'protocol.pdf').write_bytes(export_pdf(result))
    (args.output_dir / 'protocol.docx').write_bytes(export_docx(result))
    metrics = {'meeting_id': result.id, 'tasks': len(result.tasks), 'segments': len(result.segments),
               'checked_segments': result.extraction_checked_segments, 'elapsed_seconds': round(time.monotonic() - started, 1),
               'retranscribed': args.retranscribe, 'cached_transcript': bool(args.transcript_json),
               'cached_draft': bool(args.draft_json),
               'consolidation_only': args.consolidate_only,
               'accuracy': 'Requires human comparison; not inferred from task count.'}
    (args.output_dir / 'run.json').write_text(json.dumps(metrics, indent=2), encoding='utf-8')
    print(json.dumps(metrics), flush=True)


if __name__ == '__main__':
    main()
