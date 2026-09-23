import type { Task, TaskPatch } from "../types";

export type TaskDraft = Pick<
  Task,
  "title" | "description" | "assignee_type" | "status" | "reviewed"
> & {
  assignee_name: string;
  assignee_speaker_id: string;
  due_date: string;
};

export interface TaskEditor {
  /** The opening snapshot stays unchanged when fresh meeting data arrives. */
  initial: Readonly<TaskDraft>;
  draft: TaskDraft;
  /** A true confirmation is valid only after the latest substantive edit. */
  reviewAction: boolean | null;
}

const substantiveFields = [
  "title",
  "description",
  "assignee_name",
  "assignee_type",
  "assignee_speaker_id",
  "due_date",
] as const;
const editableFields = [...substantiveFields, "status"] as const;

function normalized(draft: Readonly<TaskDraft>): Required<TaskPatch> {
  return {
    ...draft,
    title: draft.title.trim(),
    description: draft.description.trim(),
    assignee_name: draft.assignee_name.trim() || null,
    assignee_speaker_id: draft.assignee_speaker_id || null,
    due_date: draft.due_date || null,
  };
}

export function startTaskEdit(task: Task): TaskEditor {
  const initial = Object.freeze({
    title: task.title,
    description: task.description,
    assignee_name: task.assignee_name ?? "",
    assignee_type: task.assignee_type,
    assignee_speaker_id:
      task.assignee_type === "person" ? (task.assignee_speaker_id ?? "") : "",
    due_date: task.due_date ?? "",
    status: task.status,
    reviewed: task.reviewed,
  });
  return { initial, draft: { ...initial }, reviewAction: null };
}

export function changeTaskDraft<K extends keyof TaskDraft>(
  editor: TaskEditor,
  key: K,
  value: TaskDraft[K],
): TaskEditor {
  if (editor.draft[key] === value) return editor;
  const draft = { ...editor.draft, [key]: value };
  if (key === "reviewed") {
    return { ...editor, draft, reviewAction: draft.reviewed };
  }
  const previous = normalized(editor.draft);
  if (
    (key === "assignee_name" || key === "assignee_type") &&
    previous[key] !== normalized(draft)[key]
  ) {
    draft.assignee_speaker_id = "";
  }
  const next = normalized(draft);
  const substantive = substantiveFields.some(
    (field) => previous[field] !== next[field],
  );
  return {
    ...editor,
    draft: substantive ? { ...draft, reviewed: false } : draft,
    reviewAction:
      substantive && editor.reviewAction !== false ? null : editor.reviewAction,
  };
}

export function buildTaskPatch(editor: TaskEditor): TaskPatch {
  const initial = normalized(editor.initial);
  const current = normalized(editor.draft);
  const patch = Object.fromEntries(
    editableFields
      .filter((field) => current[field] !== initial[field])
      .map((field) => [field, current[field]]),
  ) as TaskPatch;
  if (editor.reviewAction !== null) patch.reviewed = editor.reviewAction;
  return patch;
}
