import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, LoaderCircle, LockKeyhole } from "lucide-react";
import { api } from "../lib/api";

export function SessionDialog({
  onAuthenticated,
}: {
  onAuthenticated: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !token) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await api.login(token);
      setToken("");
      onAuthenticated();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Не удалось войти. Повторите попытку.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="upload-dialog session-dialog"
      aria-labelledby="session-title"
      onCancel={(event) => event.preventDefault()}
    >
      <form onSubmit={submit}>
        <span className="session-lock">
          <LockKeyhole size={24} />
        </span>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">MEETORA · BE LIKE AI</span>
            <h2 id="session-title">Вход в рабочее пространство</h2>
          </div>
        </div>
        <p className="muted">
          Введите код доступа, выданный владельцем сервера. После входа вы
          вернётесь к выбранному совещанию. Несохранённые правки останутся в
          этой вкладке.
        </p>
        <label className="field" htmlFor="session-token">
          Код доступа
        </label>
        <input
          className="input"
          id="session-token"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setError("");
          }}
          disabled={busy}
          required
          maxLength={512}
        />
        {error && (
          <div className="alert session-error" role="alert">
            <AlertCircle size={17} />
            <span>{error}</span>
          </div>
        )}
        <div className="dialog-actions">
          <button
            className="button button-primary"
            disabled={busy || !token}
            type="submit"
          >
            {busy ? (
              <>
                <LoaderCircle size={16} className="spin" /> Входим…
              </>
            ) : (
              "Войти"
            )}
          </button>
        </div>
        <p className="field-hint">
          Сохранение правок и отправку записи после входа нужно повторить
          вручную.
        </p>
      </form>
    </dialog>
  );
}
