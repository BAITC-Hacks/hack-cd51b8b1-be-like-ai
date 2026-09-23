import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import { buildTaskPatch, changeTaskDraft, startTaskEdit } from "./taskPatch";

function fixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Согласовать бюджет",
    description: "Проверить условия согласования",
    assignee_name: "Алия",
    assignee_type: "person",
    assignee_speaker_id: "speaker-1",
    deadline_text: "после получения сметы",
    deadline_kind: "event",
    due_date: null,
    status: "open",
    is_overdue: false,
    evidence_segment_ids: ["segment-1"],
    needs_review: true,
    review_reasons: [
      "Срок зависит от события",
      "Нужно сверить условия согласования",
    ],
    reviewed: false,
    ...overrides,
  };
}

describe("task PATCH relative to the editor opening snapshot", () => {
  it.each<Task["deadline_kind"]>([
    "event",
    "conflicting",
    "relative",
    "unspecified",
    "date",
  ])("a status change for %s sends exactly status", (deadline_kind) => {
    const original = fixture({
      deadline_kind,
      due_date: deadline_kind === "date" ? "2026-10-01" : null,
      reviewed: true,
    });
    const before = structuredClone(original);
    const editor = changeTaskDraft(
      startTaskEdit(original),
      "status",
      "in_progress",
    );
    expect(buildTaskPatch(editor)).toEqual({ status: "in_progress" });
    expect(original).toEqual(before);
  });

  it("sends null for an explicitly cleared date", () => {
    const editor = changeTaskDraft(
      startTaskEdit(fixture({ deadline_kind: "date", due_date: "2026-10-01" })),
      "due_date",
      "",
    );
    expect(buildTaskPatch(editor)).toEqual({ due_date: null });
  });

  it("omits an unchanged unknown date, assignee and voice link", () => {
    const editor = changeTaskDraft(
      startTaskEdit(
        fixture({
          assignee_name: null,
          assignee_type: "unknown",
          assignee_speaker_id: null,
        }),
      ),
      "title",
      "Уточнить бюджет",
    );
    expect(buildTaskPatch(editor)).toEqual({ title: "Уточнить бюджет" });
  });

  it("sends explicit nulls when clearing an assignee and its prior voice link", () => {
    const editor = changeTaskDraft(
      startTaskEdit(fixture()),
      "assignee_name",
      "  ",
    );
    expect(buildTaskPatch(editor)).toEqual({
      assignee_name: null,
      assignee_speaker_id: null,
    });
  });

  it("keeps the opening snapshot even if the original task changes after a speaker rename", () => {
    const original = fixture();
    let editor = startTaskEdit(original);
    original.assignee_name = "Алия Садыкова";
    editor = changeTaskDraft(editor, "status", "in_progress");
    expect(editor.draft.assignee_name).toBe("Алия");
    expect(buildTaskPatch(editor)).toEqual({ status: "in_progress" });
  });

  it("returns no changes for an untouched draft and a reverted title", () => {
    let editor = startTaskEdit(fixture({ reviewed: true }));
    expect(buildTaskPatch(editor)).toEqual({});
    editor = changeTaskDraft(editor, "title", "Другой бюджет");
    editor = changeTaskDraft(editor, "title", "Согласовать бюджет");
    expect(buildTaskPatch(editor)).toEqual({});
  });

  it("ignores whitespace-only changes and keeps a valid voice link and review", () => {
    const editor = changeTaskDraft(
      startTaskEdit(fixture({ reviewed: true })),
      "assignee_name",
      " Алия ",
    );
    expect(buildTaskPatch(editor)).toEqual({});
    expect(editor.draft.assignee_speaker_id).toBe("speaker-1");
    expect(editor.draft.reviewed).toBe(true);
  });

  it("invalidates inherited review on a substantive edit and lets the API reset it", () => {
    const editor = changeTaskDraft(
      startTaskEdit(fixture({ reviewed: true })),
      "description",
      "Новые условия",
    );
    expect(editor.draft.reviewed).toBe(false);
    expect(buildTaskPatch(editor)).toEqual({ description: "Новые условия" });
  });

  it("sends fresh confirmation after a substantive edit even if it was reviewed at opening", () => {
    let editor = changeTaskDraft(
      startTaskEdit(fixture({ reviewed: true })),
      "title",
      "Новый бюджет",
    );
    editor = changeTaskDraft(editor, "reviewed", true);
    editor = changeTaskDraft(editor, "status", "in_progress");
    expect(buildTaskPatch(editor)).toEqual({
      title: "Новый бюджет",
      status: "in_progress",
      reviewed: true,
    });
  });

  it("invalidates a fresh confirmation when another substantive edit follows", () => {
    let editor = changeTaskDraft(startTaskEdit(fixture()), "reviewed", true);
    editor = changeTaskDraft(editor, "due_date", "2026-10-01");
    expect(editor.draft.reviewed).toBe(false);
    expect(buildTaskPatch(editor)).toEqual({ due_date: "2026-10-01" });
  });

  it("sends checking and unchecking as explicit review actions", () => {
    const checked = changeTaskDraft(startTaskEdit(fixture()), "reviewed", true);
    expect(buildTaskPatch(checked)).toEqual({ reviewed: true });
    expect(buildTaskPatch(changeTaskDraft(checked, "reviewed", false))).toEqual(
      { reviewed: false },
    );
    const unchecked = changeTaskDraft(
      startTaskEdit(fixture({ reviewed: true })),
      "reviewed",
      false,
    );
    expect(buildTaskPatch(unchecked)).toEqual({ reviewed: false });
  });

  it("preserves explicit unchecking even if later text edits are reverted", () => {
    let editor = changeTaskDraft(
      startTaskEdit(fixture({ reviewed: true })),
      "reviewed",
      false,
    );
    editor = changeTaskDraft(editor, "title", "Новый бюджет");
    editor = changeTaskDraft(editor, "title", "Согласовать бюджет");
    expect(buildTaskPatch(editor)).toEqual({ reviewed: false });
  });
});
