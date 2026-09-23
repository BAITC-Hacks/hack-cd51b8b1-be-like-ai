import logging
import time
from queue import Queue, Empty
from threading import Event, Thread
from .processing import ProcessingError, align_words
from .schemas import ErrorInfo

log = logging.getLogger('uvicorn.error.hackalem.worker')


class Worker:
    def __init__(self, store, engine):
        self.store, self.engine = store, engine
        self.queue = Queue()
        self.stop_event = Event()
        self.thread = Thread(target=self.run, daemon=True, name='meeting-worker')

    def start(self):
        for meeting_id in self.store.recover():
            self.queue.put(meeting_id)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=2)

    def submit(self, meeting_id):
        self.queue.put(meeting_id)

    def stage(self, meeting_id, stage, **fields):
        def update(meeting):
            meeting.status, meeting.stage, meeting.progress = 'processing', stage, None
            for key, value in fields.items():
                setattr(meeting, key, value)
        self.store.update(meeting_id, update)
        log.info('Meeting %s: stage=%s', meeting_id, stage)

    def process(self, meeting_id):
        self.stage(meeting_id, 'decode')
        audio, duration = self.engine.decode(self.store.media_path(meeting_id))
        self.stage(meeting_id, 'transcribe', duration_seconds=duration)
        asr = self.engine.transcribe(audio)
        self.stage(meeting_id, 'diarize')
        turns = self.engine.diarize(audio)
        speakers, segments = align_words(asr, turns)
        if not speakers:
            raise ProcessingError('DIARIZATION_EMPTY', 'Не удалось выделить голоса в записи. Проверьте качество звука.')
        self.stage(meeting_id, 'extract', speakers=speakers, segments=segments)
        self.extract_saved(meeting_id)

    def extract_saved(self, meeting_id):
        current = self.store.get(meeting_id)
        if not current.segments or not current.speakers:
            raise ProcessingError('TRANSCRIPT_MISSING', 'Для повторного извлечения нужен сохранённый транскрипт с голосами.')
        self.stage(meeting_id, 'extract', error=None, extraction_checked_segments=0)
        if hasattr(self.engine, 'identify_speakers'):
            speakers = self.engine.identify_speakers(self.store.get(meeting_id))
            self.stage(meeting_id, 'extract', speakers=speakers)
        def partial(result):
            self.stage(meeting_id, 'extract', tasks=result.tasks, summary=result.summary,
                       extraction_checked_segments=result.extraction_checked_segments)
        result = self.engine.extract(self.store.get(meeting_id), on_partial=partial)
        def complete(meeting):
            meeting.speakers, meeting.tasks, meeting.summary = result.speakers, result.tasks, result.summary
            meeting.extraction_checked_segments = result.extraction_checked_segments
            meeting.status, meeting.stage, meeting.progress, meeting.error = 'ready', 'complete', 100., None
        self.store.update(meeting_id, complete)

    def run(self):
        while not self.stop_event.is_set():
            try:
                meeting_id = self.queue.get(timeout=.2)
            except Empty:
                continue
            try:
                started = time.monotonic()
                self.process(meeting_id)
                log.info('Meeting %s: complete elapsed=%.1fs', meeting_id, time.monotonic() - started)
            except Exception as exc:
                if isinstance(exc, ProcessingError):
                    log.warning('Meeting %s processing failed (%s)', meeting_id, exc.code)
                    error = ErrorInfo(code=exc.code, message=exc.message)
                elif type(exc).__name__ == 'OutOfMemoryError':
                    log.error('Meeting %s processing failed (GPU_OUT_OF_MEMORY)', meeting_id)
                    error = ErrorInfo(code='GPU_OUT_OF_MEMORY', message='Недостаточно памяти GPU. Проверьте nvidia-smi и другие процессы на сервере.')
                else:
                    # Do not leak transcript, paths, credentials, or library errors to clients/logs.
                    log.error('Meeting %s processing failed (%s)', meeting_id, type(exc).__name__)
                    error = ErrorInfo(code='PROCESSING_FAILED', message='Ошибка обработки на сервере. Проверьте установку моделей и доступность GPU.')
                def fail(meeting):
                    meeting.status, meeting.error = 'failed', error
                self.store.update(meeting_id, fail)
            finally:
                self.queue.task_done()
