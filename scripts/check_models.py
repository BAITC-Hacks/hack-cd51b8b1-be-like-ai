"""Offline model smoke check; synthetic text is used unless --audio is supplied."""
import argparse
import logging
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['PYANNOTE_METRICS_ENABLED'] = '0'

from backend.config import Settings
from backend.processing import LocalEngine, ProcessingError, align_words
from backend.schemas import Meeting, Segment, Speaker


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', type=Path, help='Optional authorized test recording already on the server')
    args = parser.parse_args()
    settings = Settings()
    engine = LocalEngine(settings)
    print('Local weights:', engine.availability(), flush=True)
    import torch
    if not torch.cuda.is_available():
        raise SystemExit('CUDA unavailable')
    print('GPU:', torch.cuda.get_device_name(0), flush=True)
    with tempfile.TemporaryDirectory(prefix='hackalem-check-') as temporary:
        if args.audio:
            audio = Path(temporary) / args.audio.name
            import shutil
            shutil.copyfile(args.audio, audio)
            normalized, duration = engine.decode(audio)
            asr = engine.transcribe(normalized)
            turns = engine.diarize(normalized)
            speakers, segments = align_words(asr, turns)
            if not speakers or not segments:
                raise SystemExit('No speech/speakers detected; inspect the recording')
            print(f'ASR + diarization completed: {duration:.1f} seconds, {len(speakers)} voices, {len(segments)} segments', flush=True)
        else:
            normalized = Path(temporary) / 'silence.wav'
            with wave.open(str(normalized), 'wb') as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(16000)
                out.writeframes(b'\0\0' * 16000 * 10)
            try:
                engine.transcribe(normalized)
            except ProcessingError as exc:
                if exc.code != 'NO_SPEECH':
                    raise
            engine.diarize(normalized)
            print('ASR/diarization initialization completed on silence; speech quality is not evaluated.', flush=True)
            speakers = [Speaker(label='SPEAKER_00', display_name='Спикер 1')]
            segments = [Segment(start=0, end=5, speaker_id=speakers[0].id,
                text='Алия, подготовьте отчёт по закупкам до 25 сентября 2026 года.')]
        meeting = Meeting(title='Проверка локальных моделей', created_at=datetime.now(timezone.utc),
                          speakers=speakers, segments=segments)
        if args.audio:
            meeting.speakers = engine.identify_speakers(meeting)
        result = engine.extract(meeting)
        print(f'LLM completed with valid sources: {len(result.tasks)} tasks.', flush=True)
        if not args.audio and not result.tasks:
            raise SystemExit('Synthetic instruction was missed; review the extraction model before demo')
        print(f'Peak PyTorch GPU allocation: {torch.cuda.max_memory_allocated() / 1024**3:.2f} GiB (excludes CTranslate2).')
        print('MODEL CHECK OK. Test Russian, Kazakh and mixed recordings separately before claiming quality.')


if __name__ == '__main__':
    main()
