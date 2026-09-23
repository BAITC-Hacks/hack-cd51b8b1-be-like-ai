import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import { api } from "../lib/api";
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
  onSource: (ids: string[]) => void;
  onEditingChange?: (editing: boolean) => void;
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
}: TaskTableProps) {
  const [filter, setFilter] = useState<Filter>("all");
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
    return () => {
      requestVersion.current += 1;
    };
  }, [meeting.id]);

  useEffect(() => {
    editingCallback.current?.(editingId !== null);
  }, [editingId]);

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
  const segmentIds = new Set(meeting.segments.map((segment) => segment.id));

  function edit(task: Task) {
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
    setEditor((current) =>
      current ? changeTaskDraft(current, key, value) : current,
    );
    setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !draft || !editingId || saving) return;
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
    if (!draft || task.id !== editingId) return null;
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
                      {speaker.identification === "suggested"
                        ? " (предположение)"
                        : speaker.identification === "unknown"
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
                  segmentIds.has(id),
                );
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
                      {task.reviewed && (
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
                      {hasSource ? (
                        <button
                          type="button"
                          className="button button-ghost tasks-source"
                          onClick={() => onSource(task.evidence_segment_ids)}
                          aria-label={`Показать источник поручения: ${task.title}`}
                        >
                          Реплика <ArrowUpRight size={15} aria-hidden="true" />
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
