"""Resume a failed/interrupted extraction using the saved transcript. Stop the API first."""
import argparse
import logging
from pathlib import Path
import socket
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.config import Settings
from backend.processing import LocalEngine, ProcessingError
from backend.schemas import ErrorInfo
from backend.storage import Store
from backend.worker import Worker


def choose_meeting(store, meeting_id=None):
    candidates = [store.get(meeting_id)] if meeting_id else store.list_all()
    for meeting in candidates:
        if meeting.status in ('processing', 'failed') and meeting.segments and meeting.speakers:
            return meeting
    raise ValueError('Нет прерванной/ошибочной записи с сохранённым транскриптом. Готовые протоколы не изменены.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument('--latest', action='store_true', help='Latest failed/interrupted meeting with a transcript')
    selector.add_argument('--meeting', help='A specific failed/interrupted meeting ID')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    # run_backend.sh binds this fixed port. Refuse to compete with its GPU worker.
    with socket.socket() as connection:
        connection.settimeout(1)
        if connection.connect_ex(('127.0.0.1', 8000)) == 0:
            raise SystemExit('Сначала остановите backend через Ctrl+C в его терминале; VM оставьте включённой.')
    settings = Settings()
    database = settings.data_dir / 'meetings.sqlite3'
    if not database.is_file():
        raise SystemExit('База совещаний не найдена. Запустите команду в исходном проекте с прежним HACKALEM_DATA_DIR.')
    store = Store(database)
    try:
        meeting = choose_meeting(store, args.meeting)
    except (ValueError, KeyError) as exc:
        raise SystemExit(str(exc)) from None
    print(f'Retry extraction: meeting={meeting.id}, segments={len(meeting.segments)}, voices={len(meeting.speakers)}', flush=True)
    worker = Worker(store, LocalEngine(settings))
    try:
        worker.extract_saved(meeting.id)
    except Exception as exc:
        code = exc.code if isinstance(exc, ProcessingError) else (
            'GPU_OUT_OF_MEMORY' if type(exc).__name__ == 'OutOfMemoryError' else 'PROCESSING_FAILED')
        message = exc.message if isinstance(exc, ProcessingError) else 'Не удалось повторить извлечение; транскрипт сохранён.'
        def fail(item):
            item.status = 'failed'
            item.error = ErrorInfo(code=code, message=message)
        store.update(meeting.id, fail)
        raise SystemExit(f'{code}: {message}') from None
    result = store.get(meeting.id)
    print(f'READY: tasks={len(result.tasks)}, named_voices={sum(s.identification != "unknown" for s in result.speakers)}', flush=True)


if __name__ == '__main__':
    main()
