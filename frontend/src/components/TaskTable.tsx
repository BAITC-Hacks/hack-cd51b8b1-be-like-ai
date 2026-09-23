import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { speakerIdentification } from "../lib/speakers";
import {
  buildTaskPatch,
  changeTaskDraft,
  startTaskEdit,
  type TaskDraft,
  type TaskEditor,
} from "../lib/taskPatch";
import type { Meeting, Task } from "../types";
import "./meeting.css";

interface TaskTableProps {
  meeting: Meeting;
  onTaskUpdated: (task: Task) => void;
  onSource: (ids: string[], revealTranscript?: boolean) => void;
  onEditingChange?: (editing: boolean) => void;
  readOnly?: boolean;
}

type Filter = "all" | "review" | "open" | "done";

const statusLabels: Record<Task["status"], string> = {
  open: "Открыто",
  in_progress: "В работе",
  done: "Выполнено",
};

function dateLabel(value: string) {
  const parts = value.split("-");
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : value;
}

function timeLabel(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours > 0 ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Не удалось сохранить поручение. Попробуйте ещё раз.";
}

export function TaskTable({
  meeting,
  onTaskUpdated,
  onSource,
  onEditingChange,
  readOnly = false,
}: TaskTableProps) {
  const editable = !readOnly && meeting.status === "ready";
  const [filter, setFilter] = useState<Filter>("all");
  const [sourceTaskId, setSourceTaskId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<TaskEditor | null>(null);
  const draft = editor?.draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestVersion = useRef(0);
  const editingCallback = useRef(onEditingChange);
  editingCallback.current = onEditingChange;

  useEffect(() => {
    requestVersion.current += 1;
    setEditingId(null);
    setEditor(null);
    setSaving(false);
    setError("");
    setNotice("");
    setFilter("all");
    setSourceTaskId(null);
    return () => {
      requestVersion.current += 1;
    };
  }, [meeting.id]);

  useEffect(() => {
    if (editable) return;
    requestVersion.current += 1;
    setEditingId(null);
    setEditor(null);
    setSaving(false);
    setError("");
    setNotice("");
  }, [editable]);

  useEffect(() => {
    editingCallback.current?.(editable && editingId !== null);
  }, [editingId, editable]);

  useEffect(() => () => editingCallback.current?.(false), []);

  const needsReview = (task: Task) => task.needs_review;
  const counts: Record<Filter, number> = {
    all: meeting.tasks.length,
    review: meeting.tasks.filter(needsReview).length,
    open: meeting.tasks.filter((task) => task.status !== "done").length,
    done: meeting.tasks.filter((task) => task.status === "done").length,
  };
  const filterLabels: Record<Filter, string> = {
    all: "Все",
    review: "Уточнить",
    open: "Открытые",
    done: "Готово",
  };
  const visibleTasks = meeting.tasks.filter(
    (task) =>
      task.id === editingId ||
      filter === "all" ||
      (filter === "review" && needsReview(task)) ||
      (filter === "open" && task.status !== "done") ||
      (filter === "done" && task.status === "done"),
  );
  const segmentsById = new Map(
    meeting.segments.map((segment) => [segment.id, segment]),
  );
  const speakersById = new Map(
    meeting.speakers.map((speaker) => [speaker.id, speaker]),
  );

  function edit(task: Task) {
    if (!editable) return;
    setEditingId(task.id);
    setEditor(startTaskEdit(task));
    setError("");
    setNotice("");
  }

  function cancel() {
    setEditingId(null);
    setEditor(null);
    setError("");
  }

  function change<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) {
    if (!editable) return;
    setEditor((current) =>
      current ? changeTaskDraft(current, key, value) : current,
    );
    setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || !editor || !draft || !editingId || saving) return;
    if (!draft.title.trim()) {
      setError("Укажите название поручения.");
      return;
    }
    const changes = buildTaskPatch(editor);
    if (Object.keys(changes).length === 0) {
      cancel();
      return;
    }
    const version = ++requestVersion.current;
    setSaving(true);
    setError("");
    try {
      const updated = await api.updateTask(meeting.id, editingId, changes);
      if (requestVersion.current !== version) return;
      onTaskUpdated(updated);
      setEditingId(null);
      setEditor(null);
      setNotice("Изменения поручения сохранены.");
    } catch (saveError) {
      if (requestVersion.current === version) setError(errorMessage(saveError));
    } finally {
      if (requestVersion.current === version) setSaving(false);
    }
  }

  function renderEditor(task: Task) {
    if (!editable || !draft || task.id !== editingId) return null;
    const fieldId = (name: string) => `task-${task.id}-${name}`;
    return (
      <tr className="tasks-editor-row" key={`${task.id}-editor`}>
        <td colSpan={6}>
          <form
            className="tasks-editor"
            onSubmit={save}
            aria-label={`Редактирование: ${task.title}`}
          >
            <div className="tasks-editor-heading">
              <div>
                <span className="tasks-eyebrow">РЕДАКТИРОВАНИЕ</span>
                <h3>Уточните поручение</h3>
              </div>
              <button
                type="button"
                className="button button-ghost tasks-icon-button"
                onClick={cancel}
                disabled={saving}
                aria-label="Закрыть редактирование"
              >
                <X size={18} />
              </button>
            </div>
            <fieldset className="tasks-editor-fields" disabled={saving}>
              <div className="field tasks-field-full">
                <label htmlFor={fieldId("title")}>Поручение</label>
                <input
                  className="input"
                  id={fieldId("title")}
                  value={draft.title}
                  onChange={(event) => change("title", event.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="field tasks-field-full">
                <label htmlFor={fieldId("description")}>Подробности</label>
                <textarea
                  className="input tasks-textarea"
                  id={fieldId("description")}
                  value={draft.description}
                  onChange={(event) =>
                    change("description", event.target.value)
                  }
                  rows={3}
                />
              </div>
              <div className="field">
                <label htmlFor={fieldId("assignee")}>Ответственный</label>
                <input
                  className="input"
                  id={fieldId("assignee")}
                  value={draft.assignee_name}
                  onChange={(event) =>
                    change("assignee_name", event.target.value)
                  }
                  placeholder="Имя или подразделение"
                />
              </div>
              <div className="field">
                <label htmlFor={fieldId("assignee-type")}>
                  Тип ответственного
                </label>
                <select
                  className="input"
                  id={fieldId("assignee-type")}
                  value={draft.assignee_type}
                  onChange={(event) =>
                    change(
                      "assignee_type",
                      event.target.value as Task["assignee_type"],
                    )
                  }
                >
                  <option value="unknown">Не определён</option>
                  <option value="person">Человек</option>
                  <option value="department">Подразделение</option>
                </select>
              </div>
              <div className="field tasks-field-full">
                <label htmlFor={fieldId("speaker")}>
                  Связь с голосом в записи{" "}
                  <span className="tasks-optional">· необязательно</span>
                </label>
                <select
                  className="input"
                  id={fieldId("speaker")}
                  value={draft.assignee_speaker_id}
                  onChange={(event) =>
                    change("assignee_speaker_id", event.target.value)
                  }
                  aria-describedby={fieldId("speaker-help")}
                  disabled={draft.assignee_type !== "person"}
                >
                  <option value="">Не связан с говорящим</option>
                  {draft.assignee_speaker_id &&
                    !meeting.speakers.some(
                      (speaker) => speaker.id === draft.assignee_speaker_id,
                    ) && (
                      <option value={draft.assignee_speaker_id}>
                        Говорящий недоступен
                      </option>
                    )}
                  {meeting.speakers.map((speaker) => (
                    <option key={speaker.id} value={speaker.id}>
                      {speaker.display_name} · {speaker.label}
                      {speakerIdentification(speaker) === "suggested"
                        ? " (имя предложено ИИ)"
                        : speakerIdentification(speaker) === "unknown"
                          ? " (имя не подтверждено)"
                          : ""}
                    </option>
                  ))}
                </select>
                <span className="tasks-help" id={fieldId("speaker-help")}>
                  {draft.assignee_type === "person"
                    ? "Ответственный может отсутствовать среди говорящих. После изменения имени связь нужно выбрать заново."
                    : "Связь с голосом доступна только для ответственного типа «Человек»."}
                </span>
              </div>
              <div className="field">
                <label htmlFor={fieldId("date")}>Дата исполнения</label>
                <input
                  className="input"
                  id={fieldId("date")}
                  type="date"
                  value={draft.due_date}
                  onChange={(event) => change("due_date", event.target.value)}
                />
                {task.deadline_text && (
                  <span className="tasks-help">
                    В записи: «{task.deadline_text}»
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor={fieldId("status")}>Статус</label>
                <select
                  className="input"
                  id={fieldId("status")}
                  value={draft.status}
                  onChange={(event) =>
                    change("status", event.target.value as Task["status"])
                  }
                >
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <label
                className="tasks-review-checkbox tasks-field-full"
                htmlFor={fieldId("reviewed")}
              >
                <input
                  id={fieldId("reviewed")}
                  type="checkbox"
                  checked={draft.reviewed}
                  onChange={(event) => change("reviewed", event.target.checked)}
                />
                <span>Я проверил поручение по исходной записи</span>
              </label>
            </fieldset>
            {error && (
              <div className="alert tasks-save-error" role="alert">
                <AlertCircle size={17} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            <div className="tasks-editor-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={cancel}
                disabled={saving}
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
                    size={16}
                    className="tasks-spinning"
                    aria-hidden="true"
                  />
                ) : (
                  <Check size={16} aria-hidden="true" />
                )}
                {saving ? "Сохраняем…" : "Сохранить"}
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  function renderSource(task: Task) {
    if (task.id !== sourceTaskId) return null;
    const evidenceIds = [...new Set(task.evidence_segment_ids)];
    return (
      <tr className="tasks-evidence-row" key={`${task.id}-evidence`}>
        <td colSpan={6}>
          <section
            className="tasks-evidence"
            id={`task-${task.id}-evidence`}
            aria-label={`Источник поручения: ${task.title}`}
          >
            <h3>Основание поручения</h3>
            {task.evidence_quote?.trim() ? (
              <div className="tasks-evidence-quote">
                <h4>Цитата, выделенная ИИ</h4>
                <blockquote>{task.evidence_quote}</blockquote>
                <p className="tasks-help">
                  Сверьте цитату с исходными репликами и аудио.
                </p>
              </div>
            ) : (
              <p className="tasks-help">
                Отдельная цитата не сохранена. Проверьте исходные реплики.
              </p>
            )}
            <h4>Исходные реплики</h4>
            {evidenceIds.length ? (
              <ol className="tasks-evidence-list">
                {evidenceIds.map((id, index) => {
                  const segment = segmentsById.get(id);
                  if (!segment)
                    return (
                      <li className="tasks-evidence-missing" key={id}>
                        <AlertCircle size={15} aria-hidden="true" />
                        Реплика {index + 1} недоступна в сохранённой расшифровке.
                      </li>
                    );
                  const speaker = segment.speaker_id
                    ? speakersById.get(segment.speaker_id)
                    : null;
                  const identification = speaker
                    ? speakerIdentification(speaker)
                    : "unknown";
                  return (
                    <li key={id}>
                      <div className="tasks-evidence-meta">
                        <span>
                          {speaker?.display_name || "Говорящий не определён"}
                        </span>
                        {speaker && identification === "suggested" && (
                          <span className="tasks-evidence-uncertain">
                            Имя предложено ИИ
                          </span>
                        )}
                        {speaker && identification === "unknown" && (
                          <span className="tasks-evidence-uncertain">
                            Имя не установлено
                          </span>
                        )}
                        <button
                          type="button"
                          className="button button-ghost tasks-evidence-jump"
                          onClick={() => onSource([id])}
                          aria-label={`К реплике ${index + 1} и аудио ${timeLabel(segment.start)}: ${task.title}`}
                        >
                          {timeLabel(segment.start)} · К аудио
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                      </div>
                      <p>{segment.text}</p>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="tasks-help">
                Связь с репликами не сохранена. Переход к фрагменту аудио недоступен.
              </p>
            )}
          </section>
        </td>
      </tr>
    );
  }

  return (
    <section className="tasks-section" aria-label="Поручения">
      <div className="tasks-filters" role="group" aria-label="Фильтр поручений">
        {(Object.keys(filterLabels) as Filter[]).map((value) => (
          <button
            key={value}
            type="button"
            className={`tasks-filter${filter === value ? " is-active" : ""}`}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {filterLabels[value]} <span>{counts[value]}</span>
          </button>
        ))}
      </div>
      {notice && (
        <p className="tasks-save-notice" role="status">
          <CheckCircle2 size={15} aria-hidden="true" />
          {notice}
        </p>
      )}
      {visibleTasks.length === 0 ? (
        <div className="empty-state tasks-empty">
          <ClipboardList size={30} aria-hidden="true" />
          <h3>
            {meeting.tasks.length
              ? "В этом фильтре пока пусто"
              : "Поручения не найдены"}
          </h3>
          <p>
            {meeting.tasks.length
              ? "Выберите другой фильтр, чтобы увидеть остальные поручения."
              : "В записи нет явно сформулированных поручений. Проверьте расшифровку ниже."}
          </p>
        </div>
      ) : (
        <div className="tasks-table-scroll">
          <table className="tasks-table">
            <caption className="tasks-visually-hidden">
              Поручения из совещания, ответственные, сроки и подтверждающие
              реплики
            </caption>
            <thead>
              <tr>
                <th scope="col">Поручение</th>
                <th scope="col">Ответственный</th>
                <th scope="col">Срок</th>
                <th scope="col">Статус</th>
                <th scope="col">Источник</th>
                <th scope="col">
                  <span className="tasks-visually-hidden">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.flatMap((task, index) => {
                const hasSource = task.evidence_segment_ids.some((id) =>
                  segmentsById.has(id),
                );
                const assigneeSpeaker = task.assignee_speaker_id
                  ? speakersById.get(task.assignee_speaker_id)
                  : undefined;
                const assigneeIdentification =
                  assigneeSpeaker &&
                  task.assignee_name === assigneeSpeaker.display_name
                    ? speakerIdentification(assigneeSpeaker)
                    : null;
                return [
                  <tr
                    key={task.id}
                    className={`tasks-data-row${task.id === editingId ? " is-editing" : ""}`}
                  >
                    <td data-label="Поручение" className="tasks-title-cell">
                      <div className="tasks-title-line">
                        <span className="tasks-row-number" aria-hidden="true">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="tasks-title">{task.title}</span>
                      </div>
                      {task.description && (
                        <p className="tasks-description">{task.description}</p>
                      )}
                      {needsReview(task) && (
                        <div className="tasks-review-note">
                          <span>
                            <AlertCircle size={13} aria-hidden="true" />
                            Нужно уточнить
                          </span>
                          {task.review_reasons.length > 0 && (
                            <ul>
                              {task.review_reasons.map(
                                (reason, reasonIndex) => (
                                  <li key={reasonIndex}>{reason}</li>
                                ),
                              )}
                            </ul>
                          )}
                        </div>
                      )}
                      {editable && task.reviewed && (
                        <span className="tasks-reviewed">
                          <CheckCircle2 size={12} aria-hidden="true" />
                          Проверено человеком
                        </span>
                      )}
                    </td>
                    <td data-label="Ответственный">
                      <span
                        className={
                          task.assignee_name ? "tasks-assignee" : "tasks-muted"
                        }
                      >
                        {task.assignee_name || "Не назначен"}
                      </span>
                      {task.assignee_type === "department" && (
                        <span className="tasks-cell-detail">Подразделение</span>
                      )}
                      {assigneeIdentification === "suggested" && (
                        <span className="tasks-cell-detail tasks-evidence-uncertain">
                          Имя предложено ИИ
                        </span>
                      )}
                      {assigneeIdentification === "unknown" && (
                        <span className="tasks-cell-detail tasks-evidence-uncertain">
                          Имя не установлено
                        </span>
                      )}
                    </td>
                    <td data-label="Срок">
                      <span
                        className={
                          task.due_date ? "tasks-due-date" : "tasks-muted"
                        }
                      >
                        {task.due_date
                          ? dateLabel(task.due_date)
                          : task.deadline_kind === "event"
                            ? "По событию"
                            : "Дата не определена"}
                      </span>
                      {task.deadline_text && (
                        <span className="tasks-deadline-original">
                          «{task.deadline_text}»
                        </span>
                      )}
                      {task.is_overdue && (
                        <span className="tasks-overdue">Просрочено</span>
                      )}
                    </td>
                    <td data-label="Статус">
                      <span
                        className={`badge tasks-status tasks-status-${task.status}`}
                      >
                        {task.status === "done" && (
                          <Check size={12} aria-hidden="true" />
                        )}
                        {statusLabels[task.status]}
                      </span>
                    </td>
                    <td data-label="Источник">
                      {hasSource || task.evidence_quote?.trim() ? (
                        <button
                          type="button"
                          className="button button-ghost tasks-source"
                          onClick={() => {
                            const opening = sourceTaskId !== task.id;
                            setSourceTaskId(opening ? task.id : null);
                            if (opening && hasSource)
                              onSource(task.evidence_segment_ids, false);
                          }}
                          aria-label={`Показать источник поручения: ${task.title}`}
                          aria-expanded={sourceTaskId === task.id}
                          aria-controls={`task-${task.id}-evidence`}
                        >
                          {hasSource ? "Реплики" : "Цитата"}
                          <ChevronDown size={15} aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="tasks-no-source">
                          {task.evidence_segment_ids.length
                            ? "Источник недоступен"
                            : "Нет источника"}
                        </span>
                      )}
                    </td>
                    <td className="tasks-action-cell">
                      <button
                        type="button"
                        className="button button-ghost tasks-icon-button"
                        onClick={() => edit(task)}
                        disabled={
                          !editable ||
                          saving ||
                          (editingId !== null && editingId !== task.id)
                        }
                        aria-label={`Редактировать поручение: ${task.title}`}
                        aria-expanded={editingId === task.id}
                      >
                        <Pencil size={15} />
                      </button>
                    </td>
                  </tr>,
                  renderSource(task),
                  renderEditor(task),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
