from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Callable
from .schemas import Meeting, ErrorInfo


class Store:
    def __init__(self, path: Path):
        self.path = path
        with self.connect() as db:
            db.executescript('''
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
                payload TEXT NOT NULL, media_path TEXT NOT NULL
              );
              CREATE TABLE IF NOT EXISTS edits (
                id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL,
                created_at TEXT NOT NULL, kind TEXT NOT NULL,
                before_json TEXT NOT NULL, after_json TEXT NOT NULL
              );
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def create(self, meeting: Meeting, media_path: Path):
        with self.connect() as db:
            db.execute('INSERT INTO meetings VALUES (?, ?, ?, ?)', (
                meeting.id, meeting.created_at.isoformat(), meeting.model_dump_json(), str(media_path)))

    def get(self, meeting_id: str) -> Meeting:
        with self.connect() as db:
            row = db.execute('SELECT payload FROM meetings WHERE id=?', (meeting_id,)).fetchone()
        if row is None:
            raise KeyError(meeting_id)
        return Meeting.model_validate_json(row['payload'])

    def media_path(self, meeting_id: str) -> Path:
        with self.connect() as db:
            row = db.execute('SELECT media_path FROM meetings WHERE id=?', (meeting_id,)).fetchone()
        if row is None:
            raise KeyError(meeting_id)
        return Path(row['media_path'])

    def list_all(self) -> list[Meeting]:
        with self.connect() as db:
            rows = db.execute('SELECT payload FROM meetings ORDER BY created_at DESC').fetchall()
        return [Meeting.model_validate_json(row['payload']) for row in rows]

    def update(self, meeting_id: str, change: Callable[[Meeting], None], audit_kind: str | None = None) -> Meeting:
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT payload FROM meetings WHERE id=?', (meeting_id,)).fetchone()
            if row is None:
                raise KeyError(meeting_id)
            meeting = Meeting.model_validate_json(row['payload'])
            change(meeting)
            # Validate mutations before persisting them.
            meeting = Meeting.model_validate(meeting.model_dump())
            payload = meeting.model_dump_json()
            db.execute('UPDATE meetings SET payload=? WHERE id=?', (payload, meeting_id))
            if audit_kind:
                db.execute('INSERT INTO edits(meeting_id,created_at,kind,before_json,after_json) VALUES (?,?,?,?,?)', (
                    meeting_id, datetime.now(timezone.utc).isoformat(), audit_kind, row['payload'], payload))
        return meeting

    def recover(self) -> list[str]:
        queued = []
        for meeting in self.list_all():
            if meeting.status == 'queued':
                queued.append(meeting.id)
            elif meeting.status == 'processing':
                def interrupted(item):
                    item.status = 'failed'
                    item.error = ErrorInfo(code='INTERRUPTED', message='Сервер перезапущен во время обработки. Загрузите запись повторно.')
                self.update(meeting.id, interrupted)
        return list(reversed(queued))
