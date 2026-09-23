from datetime import date, datetime, timezone
from io import BytesIO
import time
import zipfile

import pytest
from fastapi.testclient import TestClient
from backend.app import create_app
from backend.config import Settings
from backend.deadlines import resolve_deadline, refresh_overdue
from backend.processing import align_words, materialize_extraction, ProcessingError
from backend.schemas import Meeting, Segment, Speaker, Task, Extraction, Summary
from backend.storage import Store


class FakeEngine:
    """Only used in tests. Never selected by application configuration."""
    def availability(self):
        return {'asr': True, 'diarization': True, 'extraction': True}

    def decode(self, path):
        return path, 3.0

    def transcribe(self, path):
        return [{'start': 0., 'end': 3., 'text': 'Подготовить отчёт к пятнице.'}]

    def diarize(self, path):
        return [(0., 3., 'SPEAKER_00')]

    def extract(self, meeting):
        meeting.summary = Summary(overview='Обсуждён отчёт. Құжатты дайындау.')
        meeting.tasks = [Task(title='Подготовить отчёт', assignee_name='Участник 2', assignee_type='person',
                              deadline_text='к пятнице', deadline_kind='relative',
                              evidence_segment_ids=[meeting.segments[0].id],
                              review_reasons=['Неизвестна дата совещания'])]
        return meeting


def settings(tmp_path, **kwargs):
    return Settings(data_dir=tmp_path / 'data', model_dir=tmp_path / 'models', frontend_dir=tmp_path / 'frontend', **kwargs)


def upload(client, **fields):
    fields = {'title': 'Проверка совещания', 'participants_notified': 'true', **fields}
    return client.post('/api/meetings', data=fields, files={'file': ('meeting.wav', b'RIFF test-only fake audio', 'audio/wav')})


def await_result(client, meeting_id):
    for _ in range(100):
        result = client.get(f'/api/meetings/{meeting_id}').json()
        if result['status'] in ('ready', 'failed'):
            return result
        time.sleep(.02)
    raise AssertionError('Worker did not complete')


def test_upload_processing_edit_persistence_and_exports(tmp_path):
    config = settings(tmp_path)
    app = create_app(config, FakeEngine())
    with TestClient(app) as client:
        response = upload(client)
        assert response.status_code == 202
        meeting_id = response.json()['meeting_id']
        result = await_result(client, meeting_id)
        assert result['status'] == 'ready'
        assert result['started_at'] is None
        task = result['tasks'][0]
        assert task['due_date'] is None
        patched = client.patch(f'/api/meetings/{meeting_id}/tasks/{task["id"]}',
                              json={'due_date': '2026-10-15', 'assignee_name': 'Айдана', 'reviewed': True})
        assert patched.status_code == 200
        assert patched.json()['due_date'] == '2026-10-15'
        assert patched.json()['needs_review'] is False
        assert client.get(f'/api/meetings/{meeting_id}').json()['tasks'][0]['assignee_name'] == 'Айдана'
        pdf = client.get(f'/api/meetings/{meeting_id}/export?format=pdf')
        assert pdf.status_code == 200 and pdf.content.startswith(b'%PDF-')
        from pypdf import PdfReader
        text = '\n'.join(p.extract_text() for p in PdfReader(BytesIO(pdf.content)).pages)
        assert 'Айдана' in text and '2026-10-15' in text and 'Құжатты' in text
        docx = client.get(f'/api/meetings/{meeting_id}/export?format=docx')
        assert docx.status_code == 200
        with zipfile.ZipFile(BytesIO(docx.content)) as archive:
            xml = archive.read('word/document.xml').decode()
            assert 'Айдана' in xml and '2026-10-15' in xml
        ranged = client.get(f'/api/meetings/{meeting_id}/audio', headers={'Range': 'bytes=0-3'})
        assert ranged.status_code == 206 and ranged.content == b'RIFF'
    # A new API instance reads the persisted state, not a process-local cache.
    with TestClient(create_app(config, FakeEngine(), run_worker=False)) as client:
        assert client.get(f'/api/meetings/{meeting_id}').json()['tasks'][0]['assignee_name'] == 'Айдана'


def test_token_protects_private_routes(tmp_path):
    with TestClient(create_app(settings(tmp_path, access_token='test-private-code'), FakeEngine(), False)) as client:
        assert client.get('/api/health').status_code == 200
        assert client.get('/api/meetings').status_code == 401
        assert upload(client).status_code == 401
        assert client.post('/api/session', json={'token': 'wrong'}).status_code == 401
        response = client.post('/api/session', json={'token': 'test-private-code'})
        assert response.status_code == 200
        assert 'HttpOnly' in response.headers['set-cookie']
        assert client.get('/api/meetings').status_code == 200
        client.delete('/api/session')
        assert client.get('/api/meetings').status_code == 401


def test_invalid_uploads_and_no_fabricated_date(tmp_path):
    with TestClient(create_app(settings(tmp_path), FakeEngine(), False)) as client:
        assert upload(client, participants_notified='false').status_code == 422
        assert upload(client, started_at='2026-09-23T10:00:00').status_code == 422
        assert upload(client, timezone='Not/AZone').status_code == 422
        assert upload(client, title=' ').status_code == 422
        assert client.post('/api/meetings', data={'title': 'Test', 'participants_notified': 'true'},
                           files={'file': ('payload.exe', b'test')}).status_code == 415
        response = upload(client)
        mid = response.json()['meeting_id']
        assert client.get(f'/api/meetings/{mid}').json()['started_at'] is None
        assert client.get(f'/api/meetings/{mid}/export?format=pdf').status_code == 409
        assert client.get('/api/meetings/not-a-uuid').status_code == 422


def test_upload_limit(tmp_path):
    with TestClient(create_app(settings(tmp_path, max_upload_bytes=5), FakeEngine(), False)) as client:
        response = upload(client)
        assert response.status_code == 413
        assert client.get('/api/meetings').json()['items'] == []


def test_failed_model_does_not_return_demo_result(tmp_path):
    class Broken(FakeEngine):
        def transcribe(self, path):
            raise ProcessingError('MODEL_UNAVAILABLE', 'Модель отсутствует')
    with TestClient(create_app(settings(tmp_path), Broken())) as client:
        mid = upload(client).json()['meeting_id']
        result = await_result(client, mid)
        assert result['status'] == 'failed'
        assert result['error']['code'] == 'MODEL_UNAVAILABLE'
        assert result['tasks'] == [] and result['summary']['overview'] == ''


@pytest.mark.parametrize('raw,kind', [('до пятницы', 'relative'), ('15 октября', 'date'), ('через две недели', 'relative')])
def test_missing_reference_date(raw, kind):
    due, _, reasons = resolve_deadline(raw, kind, None, 'Asia/Almaty')
    assert due is None and reasons


def test_deadline_normalization_and_event():
    base = datetime.fromisoformat('2026-09-23T10:00:00+05:00')
    assert resolve_deadline('за две недели', 'relative', base, 'Asia/Almaty')[0] == date(2026, 10, 7)
    assert resolve_deadline('к пятнадцатому октября', 'date', base, 'Asia/Almaty')[0] == date(2026, 10, 15)
    assert resolve_deadline('15 октября 2027', 'date', None, 'Asia/Almaty')[0] == date(2027, 10, 15)
    assert resolve_deadline('после совещания', 'event', base, 'Asia/Almaty')[0] is None
    assert resolve_deadline('31 февраля 2026', 'date', base, 'Asia/Almaty')[0] is None


def test_overdue_uses_meeting_timezone_and_deadline_day_inclusive():
    meeting = Meeting(title='Test', created_at=datetime.now(timezone.utc), timezone='Asia/Almaty',
                      tasks=[Task(title='Отчёт', due_date=date(2026, 9, 23))])
    refresh_overdue(meeting, datetime.fromisoformat('2026-09-23T18:59:59+00:00'))
    assert not meeting.tasks[0].is_overdue
    refresh_overdue(meeting, datetime.fromisoformat('2026-09-23T19:00:01+00:00'))
    assert meeting.tasks[0].is_overdue
    meeting.tasks[0].status = 'done'
    refresh_overdue(meeting, datetime.fromisoformat('2026-09-24T19:00:01+00:00'))
    assert not meeting.tasks[0].is_overdue


def test_diarization_splits_at_speaker_change():
    speakers, segments = align_words([{'start': 0., 'end': 4., 'text': 'Один Два', 'words': [
        {'start': 0., 'end': 1., 'word': 'Один'}, {'start': 2., 'end': 3., 'word': ' Два'}]}],
        [(0., 1.5, 'A'), (1.5, 4., 'B')])
    assert len(speakers) == 2 and len(segments) == 2
    assert segments[0].speaker_id != segments[1].speaker_id
    assert all(s.identification == 'unknown' for s in speakers)


def test_extraction_rejects_unknown_sources_and_fabricated_deadline():
    segment = Segment(start=0., end=5., text='Юрист подготовит претензию до конца недели.')
    meeting = Meeting(title='Test', created_at=datetime.now(timezone.utc), segments=[segment])
    extracted = Extraction.model_validate({'summary': {'overview': 'Обсуждена претензия'}, 'tasks': [{
        'title': 'Подготовить претензию', 'assignee_name': 'Юрист', 'assignee_type': 'person',
        'deadline_text': '15 октября 2026', 'deadline_kind': 'date', 'evidence_segment_ids': [segment.id]}]})
    materialize_extraction(meeting, extracted)
    assert meeting.tasks[0].due_date is None and meeting.tasks[0].needs_review
    assert meeting.tasks[0].assignee_speaker_id is None
    extracted.tasks[0].evidence_segment_ids = ['invented-source']
    with pytest.raises(ValueError):
        materialize_extraction(meeting, extracted)


def test_recovery_marks_interrupted_jobs(tmp_path):
    store = Store(tmp_path / 'test.sqlite3')
    meeting = Meeting(title='Test', created_at=datetime.now(timezone.utc), status='processing', stage='diarize')
    store.create(meeting, tmp_path / 'audio.wav')
    assert store.recover() == []
    result = store.get(meeting.id)
    assert result.status == 'failed' and result.error.code == 'INTERRUPTED'
