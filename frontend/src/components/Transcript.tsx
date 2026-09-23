import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Loader2,
  MessageSquareText,
  Pencil,
  Play,
  Search,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import type { Meeting, Segment, Speaker } from "../types";
import "./meeting.css";

interface TranscriptProps {
  meeting: Meeting;
  activeSegmentId: string | null;
  onSeek: (seconds: number, segmentId: string) => void;
  onSpeakerUpdated: (speaker: Speaker) => void;
  onEditingChange?: (editing: boolean) => void;
  readOnly?: boolean;
}

const identificationLabels: Record<Speaker["identification"], string> = {
  unknown: "Имя не установлено",
  suggested: "Предположение модели",
  confirmed: "Имя подтверждено",
};

function timeLabel(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours > 0 ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query
    ? text.toLocaleLowerCase("ru").indexOf(query.toLocaleLowerCase("ru"))
    : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

export function Transcript({
  meeting,
  activeSegmentId,
  onSeek,
  onSpeakerUpdated,
  onEditingChange,
  readOnly = false,
}: TranscriptProps) {
  const editable = !readOnly && meeting.status === "ready";
  const [query, setQuery] = useState("");
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestVersion = useRef(0);
  const editingCallback = useRef(onEditingChange);
  editingCallback.current = onEditingChange;
  const queryRef = useRef(query);
  queryRef.current = query;
  const meetingRef = useRef(meeting);
  meetingRef.current = meeting;

  useEffect(() => {
    requestVersion.current += 1;
    setQuery("");
    setEditingSpeakerId(null);
    setSaving(false);
    setName("");
    setError("");
    setNotice("");
    return () => {
      requestVersion.current += 1;
    };
  }, [meeting.id]);

  useEffect(() => {
    editingCallback.current?.(editingSpeakerId !== null);
  }, [editingSpeakerId]);

  useEffect(() => {
    if (editable) return;
    requestVersion.current += 1;
    setEditingSpeakerId(null);
    setSaving(false);
    setName("");
    setError("");
    setNotice("");
  }, [editable]);

  useEffect(() => () => editingCallback.current?.(false), []);

  useEffect(() => {
    if (!activeSegmentId || !queryRef.current.trim()) return;
    const currentMeeting = meetingRef.current;
    const segment = currentMeeting.segments.find(
      (item) => item.id === activeSegmentId,
    );
    if (!segment) return;
    const speaker = currentMeeting.speakers.find(
      (item) => item.id === segment.speaker_id,
    );
    const searchableText =
      `${segment.text} ${speaker?.display_name ?? ""}`.toLocaleLowerCase("ru");
    if (
      !searchableText.includes(queryRef.current.trim().toLocaleLowerCase("ru"))
    ) {
      setQuery("");
      setNotice("Поиск сброшен, чтобы показать источник поручения.");
    }
  }, [activeSegmentId, meeting.id]);

  const speakers = new Map(
    meeting.speakers.map((speaker) => [speaker.id, speaker]),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const matches = (segment: Segment) =>
    !normalizedQuery ||
    `${segment.text} ${segment.speaker_id ? (speakers.get(segment.speaker_id)?.display_name ?? "") : ""}`
      .toLocaleLowerCase("ru")
      .includes(normalizedQuery);
  const visibleCount = meeting.segments.filter(matches).length;
  const activeSourceOutsideFilter = meeting.segments.some(
    (segment) => segment.id === activeSegmentId && !matches(segment),
  );

  function startRenaming(speaker: Speaker) {
    if (!editable) return;
    setEditingSpeakerId(speaker.id);
    setName(speaker.display_name);
    setError("");
    setNotice("");
  }

  async function saveSpeaker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || !editingSpeakerId || saving) return;
    if (!name.trim()) {
      setError("Введите имя или обозначение говорящего.");
      return;
    }
    const version = ++requestVersion.current;
    setSaving(true);
    setError("");
    try {
      const updated = await api.updateSpeaker(
        meeting.id,
        editingSpeakerId,
        name.trim(),
      );
      if (requestVersion.current !== version) return;
      onSpeakerUpdated(updated);
      setEditingSpeakerId(null);
      setNotice("Имя говорящего сохранено.");
    } catch (saveError) {
      if (requestVersion.current === version)
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Не удалось сохранить имя. Попробуйте ещё раз.",
        );
    } finally {
      if (requestVersion.current === version) setSaving(false);
    }
  }

  return (
    <section className="transcript-section" aria-label="Расшифровка">
      {meeting.speakers.length > 0 && (
        <div className="transcript-speakers" aria-label="Говорящие в записи">
          {meeting.speakers.map((speaker, index) => (
            <div className="transcript-speaker-card" key={speaker.id}>
              <div className="transcript-speaker-card-top">
                <span
                  className={`transcript-avatar transcript-color-${index % 5}`}
                  aria-hidden="true"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="transcript-speaker-info">
                  <strong>{speaker.display_name}</strong>
                  <span
                    className={`transcript-identification transcript-identification-${speaker.identification}`}
                  >
                    {speaker.identification === "confirmed" && (
                      <CheckCircle2 size={11} aria-hidden="true" />
                    )}
                    {identificationLabels[speaker.identification]}
                  </span>
                </div>
                <button
                  type="button"
                  className="button button-ghost transcript-icon-button"
                  onClick={() => startRenaming(speaker)}
                  disabled={
                    !editable ||
                    saving ||
                    (editingSpeakerId !== null &&
                      editingSpeakerId !== speaker.id)
                  }
                  aria-expanded={editingSpeakerId === speaker.id}
                  aria-label={`Изменить имя говорящего: ${speaker.display_name}`}
                >
                  <Pencil size={14} />
                </button>
              </div>
              {editable && editingSpeakerId === speaker.id && (
                <form className="transcript-name-form" onSubmit={saveSpeaker}>
                  <label htmlFor={`speaker-name-${speaker.id}`}>
                    Имя говорящего
                  </label>
                  <input
                    className="input"
                    id={`speaker-name-${speaker.id}`}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setError("");
                    }}
                    required
                    disabled={saving}
                    autoFocus
                  />
                  <p className="transcript-name-help">
                    Имя обновится в расшифровке. Ответственные поручений
                    задаются отдельно.
                  </p>
                  {error && (
                    <p className="transcript-save-error" role="alert">
                      <AlertCircle size={14} aria-hidden="true" />
                      {error}
                    </p>
                  )}
                  <div className="transcript-name-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={saving}
                      onClick={() => {
                        setEditingSpeakerId(null);
                        setError("");
                      }}
                    >
                      Отмена
                    </button>
                    <button
                      type="submit"
                      className="button button-primary"
                      disabled={saving}
                    >
                      {saving ? (
                        <Loader2
                          size={14}
                          className="transcript-spinning"
                          aria-hidden="true"
                        />
                      ) : (
                        <Check size={14} aria-hidden="true" />
                      )}
                      {saving ? "Сохраняем…" : "Сохранить"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="transcript-search-row">
        <div className="transcript-search">
          <Search size={17} aria-hidden="true" />
          <label
            htmlFor="transcript-search-input"
            className="transcript-visually-hidden"
          >
            Поиск по тексту и имени говорящего
          </label>
          <input
            id="transcript-search-input"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setNotice("");
            }}
            placeholder="Поиск по расшифровке…"
            autoComplete="off"
          />
          {query && (
            <button
              type="button"
              className="button button-ghost transcript-icon-button"
              onClick={() => setQuery("")}
              aria-label="Очистить поиск"
            >
              <X size={15} />
            </button>
          )}
        </div>
        <span className="transcript-result-count" role="status">
          {query.trim()
            ? `Найдено: ${visibleCount}`
            : `${meeting.speakers.length} голосов`}
        </span>
      </div>
      {notice && (
        <p className="transcript-notice" role="status">
          {notice}
        </p>
      )}
      {activeSourceOutsideFilter && (
        <p className="transcript-notice">
          Выбранная реплика показана вне результатов поиска.{" "}
          <button
            type="button"
            className="transcript-clear-filter"
            onClick={() => setQuery("")}
          >
            Сбросить поиск
          </button>
        </p>
      )}
      {meeting.segments.length === 0 ? (
        <div className="empty-state transcript-empty">
          <MessageSquareText size={30} aria-hidden="true" />
          <h3>Расшифровка пока пуста</h3>
          <p>Здесь появятся распознанные реплики с говорящими и таймкодами.</p>
        </div>
      ) : (
        <>
          {visibleCount === 0 && !activeSourceOutsideFilter && (
            <div className="empty-state transcript-empty">
              <Search size={28} aria-hidden="true" />
              <h3>Совпадений нет</h3>
              <p>Попробуйте другое слово или имя говорящего.</p>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setQuery("")}
              >
                Сбросить поиск
              </button>
            </div>
          )}
          <ol className="transcript-segments">
            {meeting.segments.map((segment) => {
              const speaker = segment.speaker_id
                ? speakers.get(segment.speaker_id)
                : undefined;
              const speakerIndex = speaker
                ? meeting.speakers.findIndex((item) => item.id === speaker.id)
                : -1;
              const isActive = segment.id === activeSegmentId;
              return (
                <li
                  id={`segment-${segment.id}`}
                  key={segment.id}
                  className={`transcript-segment${isActive ? " is-active" : ""}`}
                  hidden={!isActive && !matches(segment)}
                  aria-current={isActive ? "true" : undefined}
                >
                  <div className="transcript-segment-time">
                    <button
                      type="button"
                      className="transcript-timestamp"
                      onClick={() => onSeek(segment.start, segment.id)}
                      aria-label={`Прослушать с ${timeLabel(segment.start)}: ${speaker?.display_name ?? "Неизвестный голос"}`}
                    >
                      <Play size={10} fill="currentColor" aria-hidden="true" />
                      <time>{timeLabel(segment.start)}</time>
                    </button>
                  </div>
                  <div className="transcript-segment-body">
                    <div className="transcript-segment-meta">
                      <span
                        className={`transcript-speaker-dot transcript-color-${speakerIndex < 0 ? "unknown" : speakerIndex % 5}`}
                        aria-hidden="true"
                      />
                      <span className="transcript-segment-speaker">
                        {speaker?.display_name ??
                          (segment.speaker_id
                            ? "Говорящий не найден"
                            : "Неизвестный голос")}
                      </span>
                      {speaker?.identification === "suggested" && (
                        <span className="transcript-uncertain">
                          предположение
                        </span>
                      )}
                      {(!speaker || speaker.identification === "unknown") && (
                        <span className="transcript-uncertain">
                          имя не установлено
                        </span>
                      )}
                      {segment.needs_review && (
                        <span className="badge badge-warning transcript-review-badge">
                          <AlertCircle size={11} aria-hidden="true" />
                          Проверить текст
                        </span>
                      )}
                      {isActive && (
                        <span className="transcript-current-label">
                          Выбранная реплика
                        </span>
                      )}
                    </div>
                    <p>
                      <Highlight text={segment.text} query={query.trim()} />
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
