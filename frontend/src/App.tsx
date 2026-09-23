import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileAudio,
  FileText,
  Headphones,
  Layers3,
  ListChecks,
  LoaderCircle,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { api, onSessionRequired, USE_MOCKS } from "./lib/api";
import type {
  Health,
  Meeting,
  MeetingListItem,
  ProcessingStage,
  Speaker,
  Task,
} from "./types";
import { TaskTable } from "./components/TaskTable";
import { Transcript } from "./components/Transcript";
import { UploadDialog } from "./components/UploadDialog";
import { SessionDialog } from "./components/SessionDialog";

const statusLabels = {
  queued: "В очереди",
  processing: "Обрабатывается",
  ready: "Готово",
  failed: "Ошибка",
};
const stages: { id: ProcessingStage; label: string; description: string }[] = [
  {
    id: "queued",
    label: "В очереди",
    description: "Сервер принял запись и ожидает свободный обработчик.",
  },
  {
    id: "decode",
    label: "Подготовка аудио",
    description: "Подготавливаем запись к распознаванию.",
  },
  {
    id: "transcribe",
    label: "Распознавание речи",
    description: "Преобразуем речь в текст с таймкодами.",
  },
  {
    id: "diarize",
    label: "Разделение голосов",
    description: "Определяем, какие реплики принадлежат одному голосу.",
  },
  {
    id: "extract",
    label: "Извлечение поручений",
    description: "Собираем решения, поручения и подтверждающие реплики.",
  },
  {
    id: "complete",
    label: "Протокол готов",
    description: "Результат доступен для проверки.",
  },
];
const message = (err: unknown) =>
  err instanceof Error ? err.message : "Не удалось получить данные.";
function routeId() {
  const match = /^#\/meetings\/([^/?]+)/.exec(window.location.hash);
  try {
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}
function formatDate(value: string | null, timezone?: string) {
  if (!value) return "Дата не указана";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(new Date(value));
  } catch {
    return "Дата не указана";
  }
}
function duration(value: number | null) {
  if (value === null) return "Длительность неизвестна";
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

export default function App() {
  const [selectedId, setSelectedId] = useState(routeId);
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [listError, setListError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [meetingError, setMeetingError] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [reload, setReload] = useState(0);
  const [sessionRequired, setSessionRequired] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [audioError, setAudioError] = useState("");
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState<"pdf" | "docx" | null>(null);
  const [taskEditing, setTaskEditing] = useState(false);
  const [speakerEditing, setSpeakerEditing] = useState(false);
  const editing = taskEditing || speakerEditing;
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const exportLock = useRef(false);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => onSessionRequired(() => setSessionRequired(true)), []);

  function authenticated() {
    setSessionRequired(false);
    setSessionRevision((value) => value + 1);
    // Repeat safe reads only; draft components remain mounted, mutations stay manual.
    setListError("");
    setMeetingError("");
    setAudioError("");
    if (audioRef.current) {
      pendingSeek.current = audioRef.current.currentTime;
      audioRef.current.load();
    }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError("");
    try {
      await api.logout();
      setMeeting(null);
      setItems([]);
      setUploadOpen(false);
      setTaskEditing(false);
      setSpeakerEditing(false);
      setSessionRevision((value) => value + 1);
    } catch (err) {
      setLogoutError(message(err));
    } finally {
      setLoggingOut(false);
    }
  }

  const openMeeting = useCallback((id: string) => {
    window.location.hash = `/meetings/${encodeURIComponent(id)}`;
    setSelectedId(id);
    setSidebarOpen(false);
  }, []);
  useEffect(() => {
    const listener = () => setSelectedId(routeId());
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await api.health(controller.signal);
        if (!controller.signal.aborted) {
          setHealth(result);
          setHealthError("");
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setHealth(null);
          setHealthError(message(err));
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(check, 15000);
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reload]);
  useEffect(() => {
    const controller = new AbortController();
    setListLoading(true);
    setListError("");
    api
      .listMeetings(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setItems(result.items);
        if (!window.location.hash && result.items.length)
          openMeeting(result.items[0].id);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setListError(message(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    return () => controller.abort();
  }, [reload, openMeeting, sessionRevision]);
  useEffect(() => {
    setMeeting(null);
    setMeetingError("");
    setActiveSegmentId(null);
    setSourceError("");
    setExportError("");
    setAudioError("");
    setTaskEditing(false);
    setSpeakerEditing(false);
    pendingSeek.current = null;
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api.getMeeting(selectedId!, controller.signal);
        if (controller.signal.aborted) return;
        setMeeting(result);
        setMeetingError("");
        setItems((previous) =>
          previous.map((item) =>
            item.id === result.id
              ? {
                  id: result.id,
                  title: result.title,
                  started_at: result.started_at,
                  created_at: result.created_at,
                  status: result.status,
                }
              : item,
          ),
        );
        if (result.status === "queued" || result.status === "processing")
          timer = setTimeout(poll, 2000);
      } catch (err) {
        if (!controller.signal.aborted) setMeetingError(message(err));
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selectedId, reload, sessionRevision]);

  function updateTask(task: Task) {
    setMeeting((previous) =>
      previous
        ? {
            ...previous,
            tasks: previous.tasks.map((item) =>
              item.id === task.id ? task : item,
            ),
          }
        : previous,
    );
  }
  function updateSpeaker(speaker: Speaker) {
    setMeeting((previous) =>
      previous
        ? {
            ...previous,
            speakers: previous.speakers.map((item) =>
              item.id === speaker.id ? speaker : item,
            ),
            tasks: previous.tasks.map((task) =>
              task.assignee_speaker_id === speaker.id
                ? { ...task, assignee_name: speaker.display_name }
                : task,
            ),
          }
        : previous,
    );
  }
  function seek(seconds: number, segmentId: string) {
    setActiveSegmentId(segmentId);
    if (audioRef.current) {
      if (audioRef.current.readyState >= 1) {
        audioRef.current.currentTime = seconds;
        pendingSeek.current = null;
      } else {
        pendingSeek.current = seconds;
        audioRef.current.load();
      }
    }
  }
  function source(ids: string[], revealTranscript = true) {
    const found = ids
      .map((id) => meeting?.segments.find((segment) => segment.id === id))
      .filter((segment) => !!segment);
    if (!found.length) {
      setSourceError(
        "Подтверждающая реплика отсутствует. Поручение нужно проверить по исходной записи.",
      );
      return;
    }
    setSourceError(
      found.length < ids.length
        ? "Часть подтверждающих реплик отсутствует. Показан первый доступный источник."
        : "",
    );
    seek(found[0].start, found[0].id);
    if (!revealTranscript) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .getElementById(`segment-${found[0].id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      ),
    );
  }
  async function download(format: "pdf" | "docx") {
    if (!meeting || meeting.status !== "ready" || exportLock.current) return;
    exportLock.current = true;
    setExporting(format);
    setExportError("");
    const exportedMeetingId = meeting.id;
    try {
      await api.downloadExport(meeting.id, format);
    } catch (err) {
      if (selectedIdRef.current === exportedMeetingId)
        setExportError(message(err));
    } finally {
      exportLock.current = false;
      setExporting(null);
    }
  }
  const ready = meeting?.status === "ready";
  const showDraftTasks =
    !!meeting && meeting.tasks.length > 0 &&
    (meeting.status === "failed" ||
      (meeting.status === "processing" && meeting.stage === "extract"));
  const checkedSegments =
    meeting && Number.isFinite(meeting.extraction_checked_segments)
      ? Math.min(
          meeting.segments.length,
          Math.max(0, Math.floor(meeting.extraction_checked_segments ?? 0)),
        )
      : 0;
  const modelsReady = health && Object.values(health.models).every(Boolean);
  const needsReview =
    meeting?.tasks.filter((task) => task.needs_review).length || 0;
  const sourceURL = meeting ? api.audioUrl(meeting.id) : null;

  const recording = meeting ? (
    <aside className="transcript-column">
      <section className="panel audio-panel">
        <div className="section-heading">
          <div className="section-title">
            <Headphones size={18} />
            <h2>Исходная запись</h2>
          </div>
          <span className="muted small">
            {duration(meeting.duration_seconds)}
          </span>
        </div>
        {sourceURL ? (
          <>
            <audio
              key={meeting.id}
              ref={audioRef}
              controls
              preload="metadata"
              src={sourceURL}
              onError={() =>
                setAudioError(
                  "Не удалось загрузить аудио. Проверьте доступ к записи на сервере.",
                )
              }
              onLoadedMetadata={() => {
                setAudioError("");
                if (pendingSeek.current !== null && audioRef.current) {
                  audioRef.current.currentTime = pendingSeek.current;
                  pendingSeek.current = null;
                }
              }}
              aria-label="Аудиозапись совещания"
            />
            {audioError && (
              <p className="inline-error" role="alert">
                {audioError}
              </p>
            )}
          </>
        ) : (
          <div className="audio-placeholder">
            <AudioLines size={24} />
            <p>У демонстрационного примера нет аудиозаписи.</p>
          </div>
        )}
        <p className="audio-hint">
          Нажмите таймкод в реплике, чтобы перейти к нужному моменту.
        </p>
      </section>
      <section className="panel transcript-panel">
        <div className="section-heading">
          <div className="section-title">
            <FileText size={18} />
            <h2>Транскрипт</h2>
          </div>
          <span className="count-pill">{meeting.segments.length} реплик</span>
        </div>
        <Transcript
          meeting={meeting}
          activeSegmentId={activeSegmentId}
          onSeek={seek}
          onSpeakerUpdated={updateSpeaker}
          readOnly={!ready}
          onEditingChange={setSpeakerEditing}
        />
      </section>
    </aside>
  ) : null;
  const tasksPanel = meeting ? (
    <section className="panel task-panel">
      <div className="section-heading">
        <div className="section-title">
          <span className="section-icon"><ListChecks size={19} /></span>
          <h2>Поручения</h2>
          <span className="count-pill">{meeting.tasks.length}</span>
        </div>
        {ready && <span className="muted small">Проверьте перед отправкой</span>}
      </div>
      {!ready && (
        <div className="draft-notice">
          <strong>{meeting.status === "failed"
            ? "Черновик — проверка не завершена"
            : "Черновик, проверка продолжается"}</strong>
          <p>Сохранённые поручения могут быть неполными. Редактирование,
            подтверждение и экспорт доступны только после готовности протокола.</p>
        </div>
      )}
      {ready && needsReview > 0 && (
        <div className="review-notice">
          <CircleHelp size={17} />
          <span>Есть неоднозначности. Уточните исполнителей и сроки перед экспортом.</span>
        </div>
      )}
      {sourceError && (
        <div className="alert" role="alert">
          <AlertCircle size={17} />
          <span>{sourceError}</span>
          <button className="icon-button" aria-label="Скрыть сообщение об источнике"
            onClick={() => setSourceError("")}><X size={16} /></button>
        </div>
      )}
      <TaskTable meeting={meeting} onTaskUpdated={updateTask}
        onSource={source} onEditingChange={setTaskEditing} readOnly={!ready} />
    </section>
  ) : null;
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Закрыть меню"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <a href="#/" className="brand" onClick={() => setSidebarOpen(false)}>
          <span className="brand-icon">
            <AudioLines size={25} />
          </span>
          <span className="brand-wordmark">
            <span>Meetora</span>
            <span className="brand-caption">ПРОТОКОЛ СОВЕЩАНИЙ</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">BL</span>
          <div>
            <strong>Be Like AI</strong>
            <span>Команда проекта</span>
          </div>
        </div>
        <button
          className="button button-primary new-meeting"
          onClick={() => setUploadOpen(true)}
        >
          <Plus size={18} /> Новое совещание
        </button>
        <a
          className="nav-item active"
          href="#/"
          onClick={() => setSidebarOpen(false)}
        >
          <Layers3 size={18} />
          <span>Совещания</span>
          <span className="nav-count">{items.length}</span>
        </a>
        <div className="sidebar-section-title">
          <span>НЕДАВНИЕ</span>
          <button
            className="icon-button"
            onClick={() => setReload((value) => value + 1)}
            aria-label="Обновить список"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <nav className="meeting-list" aria-label="Совещания">
          {listLoading && <p className="sidebar-hint">Загружаем список…</p>}
          {listError && (
            <div className="sidebar-error" role="alert">
              {listError}
              <button onClick={() => setReload((value) => value + 1)}>
                Повторить
              </button>
            </div>
          )}
          {!listLoading && !listError && items.length === 0 && (
            <p className="sidebar-hint">Здесь появятся ваши совещания.</p>
          )}
          {items.map((item) => (
            <button
              className={`meeting-link ${selectedId === item.id ? "selected" : ""}`}
              key={item.id}
              onClick={() => openMeeting(item.id)}
            >
              <FileText size={17} />
              <span>
                <strong>{item.title}</strong>
                <small>
                  <i className={`status-dot ${item.status}`} />
                  {statusLabels[item.status]}
                  <span>·</span>
                  {formatDate(item.started_at)}
                </small>
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <ShieldCheck size={20} />
            <strong>Запись → протокол</strong>
            <p>Решения и поручения с опорой на исходный разговор.</p>
          </div>
          <div className={`connection ${healthError ? "offline" : ""}`}>
            <i />
            {USE_MOCKS
              ? "Демонстрационный режим"
              : healthError
                ? "Нет соединения с API"
                : !health
                  ? "Проверяем API…"
                  : modelsReady && health.status === "ok"
                    ? "Модели готовы"
                    : "Модели ещё готовятся"}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setSidebarOpen(true)}
              aria-label="Открыть меню"
            >
              <Menu size={21} />
            </button>
            <span>Be Like AI</span>
            <ChevronRight size={14} />
            <strong>Совещания</strong>
          </div>
          <div className="topbar-right">
            <span className="language-pill">RU / ҚАЗ</span>
            {!USE_MOCKS && (
              <button
                className="button button-ghost session-logout"
                onClick={() => void logout()}
                disabled={loggingOut}
                aria-label="Выйти"
              >
                <LogOut size={15} />
                <span>{loggingOut ? "Выходим…" : "Выйти"}</span>
              </button>
            )}
            <span className="user-avatar" title="Команда Be Like AI">
              BL
            </span>
          </div>
        </header>
        {USE_MOCKS && (
          <div className="demo-banner">
            <CircleHelp size={16} />
            <strong>Демонстрационные данные</strong>
            <span>Пример интерфейса · аудио не обрабатывается</span>
          </div>
        )}
        <main className="main-content">
          {logoutError && (
            <div className="alert" role="alert">
              {logoutError}
            </div>
          )}
          {!USE_MOCKS && healthError && (
            <div className="alert" role="alert">
              <AlertCircle size={18} />
              <div>
                <strong>Не удалось связаться с сервером.</strong>
                <p>{healthError}</p>
              </div>
              <button
                className="button button-secondary"
                onClick={() => setReload((value) => value + 1)}
              >
                Повторить
              </button>
            </div>
          )}
          {!USE_MOCKS && health && (!modelsReady || health.status !== "ok") && (
            <div className="alert info">
              <Activity size={19} />
              <span>
                Сервер доступен, но конвейер ещё не готов.{" "}
                {Object.entries(health.models)
                  .filter(([, available]) => !available)
                  .map(
                    ([name]) =>
                      ({
                        asr: "Распознавание",
                        diarization: "Разделение голосов",
                        extraction: "Извлечение поручений",
                      })[name],
                  )
                  .join(", ")}
                .
              </span>
            </div>
          )}
          {!selectedId ? (
            <div className="home-view">
              <span className="eyebrow">МЕНЬШЕ РУТИНЫ. БОЛЬШЕ ЯСНОСТИ.</span>
              <h1>
                Встреча заканчивается.
                <br />
                <span>Решения остаются.</span>
              </h1>
              <p>
                Превратите запись совещания в понятный протокол.{" "}
                <br />
                Проверьте поручения, назначьте ответственных и сохраните
                результат.
              </p>
              <button
                className="button button-primary"
                onClick={() => setUploadOpen(true)}
              >
                <Plus size={18} /> Загрузить совещание
              </button>
              <div className="home-steps">
                <div>
                  <FileAudio />
                  <strong>01. Загрузите запись</strong>
                  <span>Аудиофайл MP3 или WAV</span>
                </div>
                <div>
                  <ListChecks />
                  <strong>02. Проверьте поручения</strong>
                  <span>Каждый вывод связан с источником</span>
                </div>
                <div>
                  <ArrowDownToLine />
                  <strong>03. Сохраните протокол</strong>
                  <span>PDF и DOCX из сохранённых правок</span>
                </div>
              </div>
              {items.length > 0 && (
                <section className="home-recent">
                  <h2>Ваши совещания</h2>
                  {items.map((item) => (
                    <button key={item.id} onClick={() => openMeeting(item.id)}>
                      <FileText size={19} />
                      <strong>{item.title}</strong>
                      <span
                        className={`badge badge-${item.status === "ready" ? "success" : "neutral"}`}
                      >
                        {statusLabels[item.status]}
                      </span>
                      <ArrowRight size={18} />
                    </button>
                  ))}
                </section>
              )}
            </div>
          ) : (
            <>
              {meetingError && (
                <div className="alert" role="alert">
                  <AlertCircle size={18} />
                  <span>
                    {meetingError}{" "}
                    {meeting ? "Ниже — последние полученные данные." : ""}
                  </span>
                  <button
                    className="button button-secondary"
                    onClick={() => setReload((value) => value + 1)}
                  >
                    Повторить
                  </button>
                </div>
              )}
              {!meeting && !meetingError && (
                <div className="loading-state">
                  <LoaderCircle className="spin" size={28} />
                  <h2>Открываем совещание</h2>
                  <p>Получаем сохранённый результат.</p>
                </div>
              )}
              {meeting && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="heading-kicker">
                        <span className="eyebrow">ПРОТОКОЛ СОВЕЩАНИЯ</span>
                        <span
                          className={`badge ${ready ? "badge-success" : meeting.status === "failed" ? "badge-danger" : "badge-neutral"}`}
                        >
                          {ready && <Check size={12} />}
                          {statusLabels[meeting.status]}
                        </span>
                      </div>
                      <h1>{meeting.title}</h1>
                      <div className="meeting-meta">
                        <span>
                          <CalendarDays size={15} />
                          {formatDate(meeting.started_at, meeting.timezone)}
                        </span>
                        <span>
                          <Clock3 size={15} />
                          {duration(meeting.duration_seconds)}
                        </span>
                        <span>
                          <AudioLines size={15} />
                          {meeting.speakers.length} голосов
                        </span>
                        <span className="timezone-meta">
                          {meeting.timezone}
                        </span>
                      </div>
                    </div>
                    <div className="export-buttons">
                      <button
                        className="button button-secondary"
                        disabled={!ready || !!exporting || editing}
                        onClick={() => void download("docx")}
                      >
                        {exporting === "docx" ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <FileText size={16} />
                        )}
                        DOCX
                      </button>
                      <button
                        className="button button-primary"
                        disabled={!ready || !!exporting || editing}
                        onClick={() => void download("pdf")}
                      >
                        {exporting === "pdf" ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <ArrowDownToLine size={16} />
                        )}
                        Скачать PDF
                      </button>
                    </div>
                  </div>
                  {editing && (
                    <div className="subtle-notice">
                      Сохраните или отмените правки перед экспортом.
                    </div>
                  )}
                  {exportError && (
                    <div className="alert" role="alert">
                      <AlertCircle size={18} />
                      {exportError}
                    </div>
                  )}
                  {!ready && (
                    <section
                      className={`processing-card ${meeting.status === "failed" ? "failed" : ""}`}
                      aria-live="polite"
                    >
                      <div className="processing-icon">
                        {meeting.status === "failed" ? (
                          <AlertCircle size={30} />
                        ) : (
                          <AudioLines size={30} />
                        )}
                      </div>
                      <span className="eyebrow">
                        {meeting.status === "failed"
                          ? "ОБРАБОТКА ОСТАНОВЛЕНА"
                          : "ЗАПИСЬ В РАБОТЕ"}
                      </span>
                      <h2>
                        {meeting.status === "failed"
                          ? "Не удалось подготовить протокол"
                          : stages.find((stage) => stage.id === meeting.stage)
                              ?.label}
                      </h2>
                      <p>
                        {meeting.status === "failed"
                          ? meeting.error?.message ||
                            "Сервер сообщил об ошибке обработки."
                          : stages.find((stage) => stage.id === meeting.stage)
                              ?.description}
                      </p>
                      {meeting.status === "failed" &&
                        meeting.error?.code === "COVERAGE_CHECK_FAILED" && (
                          <p className="coverage-explanation">
                            Проверка полноты не завершилась. В сохранённом
                            черновике могут отсутствовать поручения. Полнота
                            протокола пока не подтверждена.
                          </p>
                        )}
                      {meeting.status === "failed" && meeting.error && (
                        <code>{meeting.error.code}</code>
                      )}
                      <ol className="processing-steps">
                        {stages.slice(1, 5).map((stage) => {
                          const current = stages.findIndex(
                            (item) => item.id === meeting.stage,
                          );
                          const step = stages.findIndex(
                            (item) => item.id === stage.id,
                          );
                          return (
                            <li
                              key={stage.id}
                              className={
                                step < current
                                  ? "complete"
                                  : step === current
                                    ? "current"
                                    : ""
                              }
                            >
                              <span>
                                {step < current ? <Check size={15} /> : step}
                              </span>
                              {stage.label}
                            </li>
                          );
                        })}
                      </ol>
                      {meeting.progress !== null && (
                        <div className="actual-progress">
                          <progress aria-label="Ход обработки" max={100} value={meeting.progress} />
                          <span>{meeting.progress}% · данные сервера</span>
                        </div>
                      )}
                      {checkedSegments > 0 && (
                        <div className="extraction-coverage">
                          <strong>Проверено реплик: {checkedSegments} из {meeting.segments.length}</strong>
                          <span>Охват обработки, не оценка точности.</span>
                        </div>
                      )}
                      <p className="field-hint">
                        {meeting.status === "failed"
                          ? `Последний этап: ${stages.find((stage) => stage.id === meeting.stage)?.label}.`
                          : "Статус обновляется каждые 2 секунды. Вы можете вернуться к записи позже."}
                      </p>
                    </section>
                  )}
                  {!ready && (meeting.segments.length > 0 || showDraftTasks) && (
                    <section
                      className="partial-results"
                      aria-label="Частичный результат"
                    >
                      <div className="alert info">
                        <FileText size={18} />
                        <div>
                          <strong>
                            {meeting.segments.length > 0
                              ? "Частичный результат: транскрипт сохранён"
                              : "Частичный результат: поручения сохранены"}
                          </strong>
                          <p>
                            Можно проверить доступные источники. Это сохранённая
                            часть результата, а не готовый протокол. Редактирование и
                            экспорт будут доступны после успешного завершения обработки.
                          </p>
                        </div>
                      </div>
                      {showDraftTasks ? (
                        <div className={meeting.segments.length > 0 ? "work-grid" : "draft-only"}>
                          <div className="results-column">{tasksPanel}</div>
                          {meeting.segments.length > 0 && recording}
                        </div>
                      ) : recording}
                    </section>
                  )}
                  {ready && (
                    <>
                      <div className="metric-strip">
                        <div>
                          <span className="metric-icon">
                            <ListChecks size={21} />
                          </span>
                          <span>
                            <strong>{meeting.tasks.length}</strong>
                            <small>поручений</small>
                          </span>
                        </div>
                        <div>
                          <span className="metric-icon">
                            <CheckCheck size={21} />
                          </span>
                          <span>
                            <strong>{meeting.summary.decisions.length}</strong>
                            <small>решений</small>
                          </span>
                        </div>
                        <div>
                          <span className="metric-icon amber">
                            <CircleHelp size={21} />
                          </span>
                          <span>
                            <strong>{needsReview}</strong>
                            <small>требуют проверки</small>
                          </span>
                        </div>
                        <div className="metric-note">
                          <ShieldCheck size={19} />
                          <span>
                            Проверьте результат
                            <br />
                            по исходным репликам
                          </span>
                        </div>
                      </div>
                      <div className="work-grid">
                        <div className="results-column">
                          <section className="panel summary-panel">
                            <div className="section-heading">
                              <div className="section-title">
                                <span className="section-icon">
                                  <Sparkles size={19} />
                                </span>
                                <h2>Главное из встречи</h2>
                              </div>
                              <span className="ai-label">ПРОЕКТ ПРОТОКОЛА</span>
                            </div>
                            <p className="summary-overview">
                              {meeting.summary.overview ||
                                "Саммари для этой записи отсутствует."}
                            </p>
                            <div className="summary-detail">
                              <div>
                                <h3>
                                  <CheckCheck size={16} />
                                  Принятые решения
                                </h3>
                                {meeting.summary.decisions.length ? (
                                  <ul>
                                    {meeting.summary.decisions.map(
                                      (decision, i) => (
                                        <li key={i}>{decision}</li>
                                      ),
                                    )}
                                  </ul>
                                ) : (
                                  <p className="muted">Решения не выделены.</p>
                                )}
                              </div>
                              <div className="risks-box">
                                <h3>
                                  <AlertCircle size={16} />
                                  Риски и вопросы
                                </h3>
                                {meeting.summary.risks.length ? (
                                  <ul>
                                    {meeting.summary.risks.map((risk, i) => (
                                      <li key={i}>{risk}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="muted">Риски не выделены.</p>
                                )}
                              </div>
                            </div>
                          </section>
                          {tasksPanel}
                        </div>
                        {recording}
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <AudioLines size={14} /> Meetora · Be Like AI
            </span>
            <span>Ясные решения. Проверяемые поручения.</span>
          </footer>
        </main>
      </div>
      {uploadOpen && (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          onCreated={(id) => {
            setUploadOpen(false);
            openMeeting(id);
            setReload((value) => value + 1);
          }}
        />
      )}
      {sessionRequired && <SessionDialog onAuthenticated={authenticated} />}
    </div>
  );
}
