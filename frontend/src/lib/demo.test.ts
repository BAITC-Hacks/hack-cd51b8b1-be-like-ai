import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateInTimezone, demoApi, demoMeeting, DEMO_MEETING_ID } from "./demo";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("explicit demo data", () => {
  it("invalidates inherited review after a substantive edit and accepts a fresh confirmation", () => {
    const original = demoMeeting.tasks[5];
    expect(original.reviewed).toBe(true);
    const edited = demoApi.updateTask(DEMO_MEETING_ID, original.id, {
      title: "Уточнённая проверка доступа",
    });
    expect(edited.reviewed).toBe(false);
    expect(
      demoApi.updateTask(DEMO_MEETING_ID, original.id, { reviewed: true })
        .reviewed,
    ).toBe(true);
  });

  it("preserves event deadline and reasons when only status changes", () => {
    const original = demoMeeting.tasks[4];
    const updated = demoApi.updateTask(DEMO_MEETING_ID, original.id, {
      status: "in_progress",
    });
    expect(updated.deadline_kind).toBe("event");
    expect(updated.review_reasons).toEqual(original.review_reasons);
    expect(updated.due_date).toBeNull();
  });

  it("persists task edits while retaining the original evidence and deadline text", () => {
    const original = demoMeeting.tasks[0];
    demoApi.updateTask(DEMO_MEETING_ID, original.id, {
      due_date: "2026-10-02",
      reviewed: true,
    });
    const saved = demoApi.getMeeting(DEMO_MEETING_ID).tasks[0];
    expect(saved.due_date).toBe("2026-10-02");
    expect(saved.deadline_kind).toBe("date");
    expect(saved.needs_review).toBe(false);
    expect(saved.deadline_text).toBe(original.deadline_text);
    expect(saved.evidence_segment_ids).toEqual(original.evidence_segment_ids);
  });

  it("updates only explicitly linked assignees when renaming a speaker", () => {
    const speaker = demoMeeting.speakers[2];
    demoApi.updateSpeaker(DEMO_MEETING_ID, speaker.id, "Тестовый участник");
    const meeting = demoApi.getMeeting(DEMO_MEETING_ID);
    expect(meeting.tasks[2].assignee_name).toBe("Тестовый участник");
    expect(meeting.tasks[1].assignee_name).toBe(
      "Отдел правового сопровождения",
    );
    expect(meeting.tasks[1].assignee_speaker_id).toBeNull();
  });

  it("does not claim successful saving when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() =>
      demoApi.updateTask(DEMO_MEETING_ID, demoMeeting.tasks[0].id, {
        status: "done",
      }),
    ).toThrow("Браузер не разрешил сохранить");
  });

  it("uses the meeting timezone when evaluating a calendar day", () => {
    expect(
      dateInTimezone(new Date("2026-09-23T20:30:00Z"), "Asia/Almaty"),
    ).toBe("2026-09-24");
  });

  it("keeps unresolved relative and event deadlines undated", () => {
    const meeting = demoApi.getMeeting(DEMO_MEETING_ID);
    expect(meeting.started_at).toBeNull();
    for (const task of meeting.tasks.filter((item) =>
      ["relative", "event", "conflicting"].includes(item.deadline_kind),
    )) {
      expect(task.due_date).toBeNull();
      expect(task.is_overdue).toBe(false);
    }
  });
});
