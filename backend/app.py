from contextlib import asynccontextmanager
from datetime import datetime, timezone as dt_timezone
import hmac
from pathlib import Path
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field, ValidationError
from starlette.datastructures import UploadFile
from starlette.staticfiles import StaticFiles

from .config import Settings
from .deadlines import refresh_overdue
from .exports import export_docx, export_pdf
from .processing import LocalEngine
from .schemas import Meeting, SpeakerPatch, TaskPatch
from .storage import Store
from .worker import Worker


def problem(code, message, status):
    return JSONResponse({'error': {'code': code, 'message': message}}, status_code=status)


class RequestTooLarge(Exception):
    pass


class BodyLimit:
    def __init__(self, app, limit):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        size = 0
        async def limited_receive():
            nonlocal size
            message = await receive()
            if message['type'] == 'http.request':
                size += len(message.get('body', b''))
                if size > self.limit:
                    raise RequestTooLarge()
            return message
        try:
            await self.app(scope, limited_receive, send)
        except RequestTooLarge:
            await problem('FILE_TOO_LARGE', 'Файл превышает допустимый размер.', 413)(scope, receive, send)


class SessionLogin(BaseModel):
    token: str = Field(min_length=1, max_length=512)


LOGIN_HTML = '''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Доступ к ассистенту совещаний</title><style>body{font:17px system-ui;max-width:480px;margin:12vh auto;padding:24px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin:8px 0}#error{color:#a00}</style>
<h1>Ассистент совещаний</h1><p>Введите код доступа, выданный владельцем сервера.</p>
<form id="form"><input id="token" type="password" autocomplete="current-password" required aria-label="Код доступа"><button>Войти</button></form><p id="error"></p>
<script>document.querySelector('#form').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.querySelector('#token').value})});if(r.ok){location.href='/'}else{document.querySelector('#error').textContent='Неверный код доступа'}}catch{document.querySelector('#error').textContent='Не удалось связаться с сервером'}};</script></html>'''


def create_app(settings: Settings | None = None, engine=None, run_worker=True):
    settings = settings or Settings()
    settings.prepare()
    store = Store(settings.data_dir / 'meetings.sqlite3')
    engine = engine or LocalEngine(settings)
    worker = Worker(store, engine)

    @asynccontextmanager
    async def lifespan(app):
        if run_worker:
            worker.start()
        yield
        if run_worker:
            worker.stop()

    app = FastAPI(title='HackAlem meeting assistant', version='0.1.0', lifespan=lifespan)
    app.state.store, app.state.engine, app.state.settings = store, engine, settings
    app.add_middleware(BodyLimit, limit=settings.max_upload_bytes + 65536)

    @app.middleware('http')
    async def authenticate(request, call_next):
        path = request.url.path
        if settings.access_token and request.method != 'OPTIONS' and path not in ('/api/session', '/api/health', '/login'):
            bearer = request.headers.get('authorization', '')
            provided = bearer[7:] if bearer.startswith('Bearer ') else request.cookies.get('hackalem_session', '')
            if not hmac.compare_digest(provided.encode(), settings.access_token.encode()):
                if path.startswith('/api/'):
                    return problem('UNAUTHORIZED', 'Требуется код доступа к приложению.', 401)
                from fastapi.responses import RedirectResponse
                return RedirectResponse('/login', status_code=303)
        response = await call_next(request)
        if path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                       allow_methods=['GET', 'POST', 'PATCH', 'DELETE'], allow_headers=['Content-Type', 'Authorization'])

    @app.exception_handler(KeyError)
    async def not_found(request, exc):
        return problem('NOT_FOUND', 'Совещание или объект не найден.', 404)

    @app.get('/api/health')
    def health():
        models = engine.availability()
        return {'status': 'ok' if all(models.values()) else 'degraded', 'models': models}

    @app.get('/login', response_class=HTMLResponse)
    def login_page():
        return LOGIN_HTML

    @app.post('/api/session')
    def login(body: SessionLogin):
        if not settings.access_token or not hmac.compare_digest(body.token.encode(), settings.access_token.encode()):
            return problem('UNAUTHORIZED', 'Неверный код доступа.', 401)
        response = JSONResponse({'status': 'ok'})
        response.set_cookie('hackalem_session', body.token, httponly=True, secure=settings.secure_cookie,
                            samesite='strict', max_age=12 * 3600)
        return response

    @app.delete('/api/session')
    def logout():
        response = JSONResponse({'status': 'ok'})
        response.delete_cookie('hackalem_session')
        return response

    @app.post('/api/meetings')
    async def upload(request: Request):
        async with request.form(max_files=1, max_fields=6, max_part_size=16384) as form:
            audio = form.get('file')
            if not isinstance(audio, UploadFile):
                return problem('FILE_REQUIRED', 'Выберите файл MP3 или WAV.', 422)
            suffix = Path(audio.filename or '').suffix.lower()
            if suffix not in ('.mp3', '.wav'):
                return problem('UNSUPPORTED_FILE', 'Поддерживаются MP3 и WAV.', 415)
            if str(form.get('participants_notified', '')).lower() != 'true':
                return problem('NOTICE_REQUIRED', 'Подтвердите уведомление участников о записи.', 422)
            title = str(form.get('title', '')).strip()
            tz = str(form.get('timezone', 'Asia/Almaty'))
            try:
                ZoneInfo(tz)
                started_text = form.get('started_at')
                started = datetime.fromisoformat(str(started_text).replace('Z', '+00:00')) if started_text else None
                if started and (started.tzinfo is None or started.utcoffset() is None):
                    raise ValueError('Timezone offset required')
                meeting = Meeting(title=title, created_at=datetime.now(dt_timezone.utc), started_at=started, timezone=tz)
            except (ValueError, ZoneInfoNotFoundError, ValidationError):
                return problem('INVALID_METADATA', 'Укажите название, корректную дату со смещением UTC и часовой пояс.', 422)
            directory = settings.data_dir / 'uploads' / meeting.id
            directory.mkdir()
            target = directory / ('original' + suffix)
            total = 0
            try:
                with target.open('xb') as out:
                    while chunk := await audio.read(1024 * 1024):
                        total += len(chunk)
                        if total > settings.max_upload_bytes:
                            raise RequestTooLarge()
                        out.write(chunk)
                if not total:
                    target.unlink()
                    directory.rmdir()
                    return problem('EMPTY_FILE', 'Файл пуст.', 422)
                store.create(meeting, target)
            except BaseException:
                target.unlink(missing_ok=True)
                directory.rmdir()
                raise
        worker.submit(meeting.id)
        return JSONResponse({'meeting_id': meeting.id, 'status': 'queued'}, status_code=202)

    @app.get('/api/meetings')
    def meetings():
        return {'items': [m.model_dump(include={'id', 'title', 'started_at', 'created_at', 'status'}) for m in store.list_all()]}

    @app.get('/api/meetings/{meeting_id}')
    def meeting(meeting_id: UUID):
        return refresh_overdue(store.get(str(meeting_id)))

    @app.get('/api/meetings/{meeting_id}/audio')
    def audio(meeting_id: UUID):
        path = store.media_path(str(meeting_id))
        return FileResponse(path, media_type='audio/mpeg' if path.suffix == '.mp3' else 'audio/wav')

    @app.patch('/api/meetings/{meeting_id}/tasks/{task_id}')
    def edit_task(meeting_id: UUID, task_id: UUID, patch: TaskPatch):
        if store.get(str(meeting_id)).status != 'ready':
            return problem('NOT_READY', 'Дождитесь завершения обработки.', 409)
        def change(meeting):
            task = next((t for t in meeting.tasks if t.id == str(task_id)), None)
            if task is None:
                raise KeyError(task_id)
            changes = patch.model_dump(exclude_unset=True)
            speaker_ids = {s.id for s in meeting.speakers}
            if changes.get('assignee_speaker_id') and changes['assignee_speaker_id'] not in speaker_ids:
                raise ValueError('Unknown speaker')
            # Changing a name without explicitly linking a speaker breaks the previous identity link.
            if 'assignee_name' in changes and 'assignee_speaker_id' not in changes:
                changes['assignee_speaker_id'] = None
            for key, value in changes.items():
                setattr(task, key, value)
            if 'due_date' in changes:
                task.deadline_kind = 'date' if task.due_date else ('relative' if task.deadline_text else 'unspecified')
            substantive = bool(set(changes) - {'status', 'reviewed'})
            if substantive and 'reviewed' not in changes:
                task.reviewed = False
            if task.reviewed:
                task.review_reasons = []
            elif substantive:
                task.review_reasons = ['Проверьте изменённое поручение']
            if not task.assignee_name:
                task.assignee_type = 'unknown'
                task.assignee_speaker_id = None
                task.review_reasons.append('Ответственный не установлен')
            if task.due_date is None:
                task.review_reasons.append('Календарный срок не определён')
            task.review_reasons = list(dict.fromkeys(task.review_reasons))
            task.needs_review = bool(task.review_reasons)
        try:
            result = refresh_overdue(store.update(str(meeting_id), change, audit_kind='task'))
        except ValueError:
            return problem('INVALID_SPEAKER', 'Указанный спикер отсутствует в совещании.', 422)
        return next(t for t in result.tasks if t.id == str(task_id))

    @app.patch('/api/meetings/{meeting_id}/speakers/{speaker_id}')
    def edit_speaker(meeting_id: UUID, speaker_id: UUID, patch: SpeakerPatch):
        if store.get(str(meeting_id)).status != 'ready':
            return problem('NOT_READY', 'Дождитесь завершения обработки.', 409)
        def change(meeting):
            speaker = next((s for s in meeting.speakers if s.id == str(speaker_id)), None)
            if speaker is None:
                raise KeyError(speaker_id)
            speaker.display_name, speaker.identification = patch.display_name, 'confirmed'
            for task in meeting.tasks:
                if task.assignee_speaker_id == speaker.id:
                    task.assignee_name = speaker.display_name
        result = store.update(str(meeting_id), change, audit_kind='speaker')
        return next(s for s in result.speakers if s.id == str(speaker_id))

    @app.get('/api/meetings/{meeting_id}/export')
    def export(meeting_id: UUID, format: str = 'pdf'):
        if format not in ('pdf', 'docx'):
            return problem('INVALID_FORMAT', 'Выберите pdf или docx.', 422)
        meeting = refresh_overdue(store.get(str(meeting_id)))
        if meeting.status != 'ready':
            return problem('NOT_READY', 'Дождитесь завершения обработки.', 409)
        try:
            data = export_pdf(meeting) if format == 'pdf' else export_docx(meeting)
        except RuntimeError:
            return problem('EXPORT_UNAVAILABLE', 'Для PDF установите шрифты DejaVu на сервере.', 503)
        mime = 'application/pdf' if format == 'pdf' else 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        return Response(data, media_type=mime, headers={'Content-Disposition': f'attachment; filename="protocol-{meeting.id}.{format}"'})

    if settings.frontend_dir.is_dir():
        app.mount('/', StaticFiles(directory=settings.frontend_dir, html=True), name='frontend')
    else:
        @app.get('/')
        def index():
            return {'message': 'Backend запущен. Соберите frontend в frontend/dist.', 'docs': '/docs'}
    return app
