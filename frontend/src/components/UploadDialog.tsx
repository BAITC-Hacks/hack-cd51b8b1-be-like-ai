import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  FileAudio,
  LoaderCircle,
  UploadCloud,
  X,
} from "lucide-react";
import { api, USE_MOCKS } from "../lib/api";
import { meetingDateToISO } from "../uploadDate";

export function UploadDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [timezone, setTimezone] = useState("Asia/Almaty");
  const [notified, setNotified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => {
      requestRef.current?.abort();
    };
  }, []);

  function chooseFile(next?: File) {
    if (!next) return;
    if (!/\.(mp3|wav)$/i.test(next.name)) {
      setError("Выберите аудиофайл MP3 или WAV.");
      return;
    }
    if (!next.size) {
      setError("Файл пустой. Выберите другую запись.");
      return;
    }
    setError("");
    setFile(next);
    if (!title.trim()) setTitle(next.name.replace(/\.[^.]+$/, ""));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    if (!file || !title.trim() || !notified) {
      setError(
        "Укажите название, выберите запись и подтвердите уведомление участников.",
      );
      return;
    }
    setError("");
    let started_at: string | undefined;
    try {
      started_at = meetingDateToISO(date, timezone);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Проверьте дату.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    requestRef.current = new AbortController();
    try {
      const result = await api.createMeeting(
        {
          file,
          title: title.trim(),
          ...(started_at ? { started_at } : {}),
          timezone,
          participants_notified: notified,
        },
        requestRef.current.signal,
      );
      onCreated(result.meeting_id);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError"))
        setError(
          err instanceof Error ? err.message : "Не удалось отправить запись.",
        );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="upload-dialog"
      aria-labelledby="upload-dialog-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">НОВОЕ СОВЕЩАНИЕ</span>
            <h2 id="upload-dialog-title">От записи к поручениям</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p className="muted">
          Загрузите аудио. После обработки проверьте протокол и подтвердите
          поручения.
        </p>
        {USE_MOCKS && (
          <div className="alert info">
            Демонстрационный режим: обработка новых записей недоступна. Для
            загрузки запустите интерфейс с настоящим API.
          </div>
        )}
        <label className="field">
          Название совещания
          <input
            autoFocus
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Например, планирование запуска"
            disabled={busy}
          />
        </label>
        <input
          ref={fileInput}
          id="audio-upload"
          className="sr-only"
          type="file"
          accept=".mp3,.wav,audio/mpeg,audio/wav"
          onChange={(event) => chooseFile(event.target.files?.[0])}
          disabled={busy}
          aria-label="Аудиозапись MP3 или WAV"
        />
        <button
          type="button"
          className={`dropzone ${dragging ? "is-dragging" : ""}`}
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!busy) chooseFile(event.dataTransfer.files[0]);
          }}
        >
          <span className="upload-icon">
            {file ? <FileAudio size={26} /> : <UploadCloud size={26} />}
          </span>
          <strong>{file ? file.name : "Выберите или перетащите запись"}</strong>
          <span>
            {file
              ? `${(file.size / 1024 / 1024).toFixed(1)} МБ · Нажмите, чтобы заменить`
              : "MP3 или WAV · исходная аудиозапись"}
          </span>
        </button>
        <div className="form-columns">
          <label className="field">
            Дата и время <span className="optional">необязательно</span>
            <input
              type="datetime-local"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            Часовой пояс
            <select
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              disabled={busy}
            >
              <option value="Asia/Almaty">Алматы · Asia/Almaty</option>
              <option value="Asia/Qyzylorda">Кызылорда · Asia/Qyzylorda</option>
              <option value="Europe/Moscow">Москва · Europe/Moscow</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
        </div>
        <p className="field-hint">
          Не знаете дату — оставьте поле пустым. Относительные сроки будут
          отмечены для проверки.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={notified}
            onChange={(event) => setNotified(event.target.checked)}
            disabled={busy}
            required
          />
          <span>Подтверждаю, что участники уведомлены о записи совещания.</span>
        </label>
        {error && (
          <div className="alert" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Отмена
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || USE_MOCKS}
          >
            {busy ? (
              <>
                <LoaderCircle size={17} className="spin" /> Отправляем запись…
              </>
            ) : (
              <>
                Создать протокол <ArrowUpRight size={17} />
              </>
            )}
          </button>
        </div>
        {busy && (
          <p className="field-hint">
            Дождитесь ответа сервера. Повторная отправка заблокирована.
          </p>
        )}
      </form>
    </dialog>
  );
}
