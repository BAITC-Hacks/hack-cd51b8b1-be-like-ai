import { expect, test, type Page } from "@playwright/test";
import type { Meeting, Task, TaskPatch } from "../src/types";

const MEETING_ID = "00000000-0000-4000-8000-000000000011";

function fixture(task: Partial<Task> = {}): Meeting {
  return {
    id: MEETING_ID,
    title: "Согласование бюджета",
    started_at: null,
    created_at: "2026-09-23T05:00:00Z",
    status: "ready",
    timezone: "Asia/Almaty",
    duration_seconds: 30,
    stage: "complete",
    progress: 100,
    error: null,
    speakers: [
      {
        id: "speaker-1",
        label: "SPEAKER_00",
        display_name: "Алия",
        identification: "confirmed",
      },
    ],
    segments: [
      {
        id: "segment-1",
        start: 0,
        end: 10,
        speaker_id: "speaker-1",
        text: "Согласую бюджет после получения сметы.",
        needs_review: false,
      },
    ],
    summary: { overview: "Обсудили бюджет.", decisions: [], risks: [] },
    tasks: [
      {
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
        ...task,
      },
    ],
  };
}

async function openEditor(page: Page, task: Partial<Task> = {}) {
  const meeting = fixture(task);
  const patches: TaskPatch[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const send = (json: unknown) => route.fulfill({ json });
    if (path === "/api/health")
      return send({
        status: "ok",
        models: { asr: true, diarization: true, extraction: true },
      });
    if (path === "/api/meetings") return send({ items: [meeting] });
    if (path === `/api/meetings/${MEETING_ID}`) return send(meeting);
    if (path.endsWith("/audio")) return route.fulfill({ status: 204 });
    if (path.endsWith("/tasks/task-1") && request.method() === "PATCH") {
      const patch = request.postDataJSON() as TaskPatch;
      patches.push(patch);
      Object.assign(meeting.tasks[0], patch);
      // This fixture only returns data. Assertions below inspect the exact
      // outbound payload; backend rules are covered by the integration suite.
      return send(meeting.tasks[0]);
    }
    if (path.endsWith("/speakers/speaker-1") && request.method() === "PATCH") {
      const { display_name } = request.postDataJSON() as {
        display_name: string;
      };
      meeting.speakers[0].display_name = display_name;
      meeting.tasks[0].assignee_name = display_name;
      return send(meeting.speakers[0]);
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`/#/meetings/${MEETING_ID}`);
  await page
    .getByRole("button", {
      name: "Редактировать поручение: Согласовать бюджет",
    })
    .click();
  const form = page.getByRole("form", {
    name: "Редактирование: Согласовать бюджет",
  });
  return { form, patches };
}

for (const deadline_kind of [
  "event",
  "conflicting",
  "relative",
  "unspecified",
  "date",
] as const) {
  test(`status-only PATCH omits all deadline and review fields for ${deadline_kind}`, async ({
    page,
  }) => {
    const { form, patches } = await openEditor(page, {
      deadline_kind,
      due_date: deadline_kind === "date" ? "2026-10-01" : null,
      reviewed: true,
    });
    await form
      .getByLabel("Статус", { exact: true })
      .selectOption("in_progress");
    await form.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(patches).toEqual([{ status: "in_progress" }]);
  });
}

test("saving unchanged values closes the editor without a PATCH", async ({
  page,
}) => {
  const { form, patches } = await openEditor(page);
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(patches).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Скачать PDF", exact: true }),
  ).toBeEnabled();
});

test("clearing a known date sends an explicit null", async ({ page }) => {
  const { form, patches } = await openEditor(page, {
    deadline_kind: "date",
    due_date: "2026-10-01",
  });
  await form.getByLabel("Дата исполнения", { exact: true }).fill("");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(patches).toEqual([{ due_date: null }]);
});

test("a linked speaker rename during editing survives a status-only save", async ({
  page,
}) => {
  const { form, patches } = await openEditor(page);
  await page
    .getByRole("button", { name: "Изменить имя говорящего: Алия" })
    .click();
  await page
    .getByLabel("Имя говорящего", { exact: true })
    .fill("Алия Садыкова");
  await page
    .locator(".transcript-name-form")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.locator(".tasks-assignee")).toHaveText("Алия Садыкова");
  await expect(form.getByLabel("Ответственный", { exact: true })).toHaveValue(
    "Алия",
  );
  await form.getByLabel("Статус", { exact: true }).selectOption("in_progress");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(patches).toEqual([{ status: "in_progress" }]);
  await expect(page.locator(".tasks-assignee")).toHaveText("Алия Садыкова");
});

test("review requires confirmation after the final substantive edit", async ({
  page,
}) => {
  const { form, patches } = await openEditor(page, { reviewed: true });
  const checked = form.getByRole("checkbox", {
    name: "Я проверил поручение по исходной записи",
  });
  await expect(checked).toBeChecked();
  await form
    .getByLabel("Поручение", { exact: true })
    .fill("Согласовать новый бюджет");
  await expect(checked).not.toBeChecked();
  await checked.check();
  await form
    .getByLabel("Подробности", { exact: true })
    .fill("Уточнённые условия");
  await expect(checked).not.toBeChecked();
  await checked.check();
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(patches).toEqual([
    {
      title: "Согласовать новый бюджет",
      description: "Уточнённые условия",
      reviewed: true,
    },
  ]);
});
