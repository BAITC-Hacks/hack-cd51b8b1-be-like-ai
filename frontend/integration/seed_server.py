"""Real FastAPI/SQLite/export integration fixtures. No GPU, inference or user data."""

from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import wave

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import uvicorn

from backend.app import create_app
from backend.config import Settings
from backend.schemas import ErrorInfo, Meeting, Segment, Speaker, Summary, Task


def fixture_id(number):
    return f"00000000-0000-4000-8000-{number:012d}"


def seed(app, directory):
    audio = directory / "synthetic-silence.wav"
    with wave.open(str(audio), "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(8000)
        recording.writeframes(b"\x00\x00" * 8000 * 90)

    speaker = Speaker(id=fixture_id(100), label="SPEAKER_00", display_name="Алия")
    segments = [
        Segment(id=fixture_id(101), start=3, end=12, speaker_id=speaker.id,
                text="Сначала обсудим бюджет проекта."),
        Segment(id=fixture_id(102), start=42, end=54, speaker_id=speaker.id,
                text="Алия, согласуйте бюджет после получения сметы."),
    ]

    def meeting(number, title, **changes):
        return Meeting(
            id=fixture_id(number), title=title,
            created_at=datetime(2026, 9, 23, 5, tzinfo=timezone.utc),
            duration_seconds=90, status="ready", stage="complete", progress=100,
            speakers=[speaker], segments=segments,
            summary=Summary(overview="Синтетический пример для проверки UI/API."),
        ).model_copy(update=changes, deep=True)

    def event_task():
        return Task(
            id=fixture_id(200), title="Согласовать бюджет",
            description="Проверить условия согласования",
            assignee_name="Алия", assignee_type="person", assignee_speaker_id=speaker.id,
            deadline_text="после получения сметы", deadline_kind="event", due_date=None,
            evidence_segment_ids=[fixture_id(102)],
            review_reasons=["Срок зависит от события", "Нужно сверить условия согласования"],
        )

    # Mutable fixtures belong to one project/flow each; no reset HTTP endpoint.
    for number in (1, 2, 3, 4):
        item = meeting(number, f"Интеграция {number}", tasks=[event_task()])
        app.state.store.create(item, audio)

    partial = [
        meeting(10, "Ошибка после распознавания", status="failed", stage="extract", progress=80,
                error=ErrorInfo(code="EXTRACTION_FAILED", message="Синтетическая ошибка извлечения")),
        meeting(11, "Извлечение поручений", status="processing", stage="extract", progress=80),
        meeting(12, "Ошибка до распознавания", status="failed", stage="decode", progress=0,
                speakers=[], segments=[],
                error=ErrorInfo(code="DECODE_FAILED", message="Синтетическая ошибка декодирования")),
        meeting(13, "Готово без поручений"),
    ]
    for item in partial:
        app.state.store.create(item, audio)


def main():
    token = os.environ.get("MEETORA_INTEGRATION_TOKEN")
    if not token:
        raise SystemExit("Run through playwright.integration.config.ts: test token is required.")
    if not (ROOT / "frontend" / "dist" / "index.html").is_file():
        raise SystemExit("Run npm run build in frontend before the integration suite.")
    with TemporaryDirectory(prefix="meetora-ui-integration-") as temporary:
        directory = Path(temporary)
        settings = Settings(
            data_dir=directory / "data", model_dir=directory / "absent-models",
            frontend_dir=ROOT / "frontend" / "dist", access_token=token,
            secure_cookie=False, device="cpu", cors_origins=[],
        )
        # The real application, routes, validation, audit, media and exporters run.
        # The inference worker is disabled and model files are deliberately absent.
        app = create_app(settings=settings, run_worker=False)
        seed(app, directory)
        uvicorn.run(app, host="127.0.0.1", port=8189, log_level="warning")


if __name__ == "__main__":
    main()
