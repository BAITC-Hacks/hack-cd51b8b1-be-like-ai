import { expect, test, type Page } from "@playwright/test";
import type { Meeting } from "../src/types";

const MEETING_ID = "00000000-0000-4000-8000-000000000031";
const SEGMENT_TEXT = "Сверим условия согласования после получения сметы.";
const TASK_TITLE = "Согласовать смету";

function fixture(status: Meeting["status"]): Meeting {
  return {
    id: MEETING_ID,
    title: "Проверка частичного результата",
    started_at: null,
    created_at: "2026-09-23T05:00:00Z",
    status,
    timezone: "Asia/Almaty",
    duration_seconds: 30,
    stage: status === "ready" ? "complete" : "extract",
    progress: status === "ready" ? 100 : 80,
    error:
      status === "failed"
        ? { code: "EXTRACTION_FAILED", message: "Модель извлечения недоступна" }
        : null,
    speakers: [
      {
        id: "speaker-1",
        label: "SPEAKER_00",
        display_name: "Голос 1",
        identification: "unknown",
      },
    ],
    segments: [
      {
        id: "segment-saved",
        start: 12,
        end: 24,
        speaker_id: "speaker-1",
        text: SEGMENT_TEXT,
        needs_review: false,
      },
    ],
    summary: { overview: "", decisions: [], risks: [] },
    tasks: [],
  };
}

function draftFixture(): Meeting {
  const meeting = fixture("processing");
  meeting.extraction_checked_segments = 1;
  meeting.segments.push({
    id: "segment-next-week",
    start: 24,
    end: 29,
    speaker_id: "speaker-1",
    text: "Алия, согласуйте смету на следующей неделе после проверки всех площадок.",
    needs_review: false,
  });
  meeting.tasks = [
    {
      id: "task-draft",
      title: TASK_TITLE,
      description: "Проверить все площадки и приложить сводный отчёт.",
      assignee_name: "Алия",
      assignee_type: "person",
      assignee_speaker_id: null,
      deadline_text: "на следующей неделе",
      deadline_kind: "relative",
      due_date: null,
      status: "open",
      is_overdue: false,
      evidence_segment_ids: ["segment-next-week"],
      needs_review: true,
      review_reasons: ["Неизвестна дата встречи"],
      reviewed: false,
    },
  ];
  return meeting;
}

function wav() {
  const rate = 8000;
  const length = rate * 30 * 2;
  const buffer = Buffer.alloc(44 + length);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + length, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(length, 40);
  return buffer;
}

async function serveMeeting(
  page: Page,
  meeting: Meeting,
  options: { failReads?: boolean; reads?: number; writes?: number } = {},
) {
  const audio = wav();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET") options.writes = (options.writes ?? 0) + 1;
    const send = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (pathname === "/api/health")
      return send({
        status: "ok",
        models: { asr: true, diarization: true, extraction: true },
      });
    if (pathname === "/api/meetings") return send({ items: [meeting] });
    if (pathname === `/api/meetings/${MEETING_ID}`) {
      options.reads = (options.reads ?? 0) + 1;
      if (options.failReads) return route.abort("connectionfailed");
      return send(meeting);
    }
    if (pathname === `/api/meetings/${MEETING_ID}/audio`) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2]
        ? Math.min(Number(range[2]), audio.length - 1)
        : audio.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        body: audio.subarray(start, end + 1),
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          ...(range
            ? { "Content-Range": `bytes ${start}-${end}/${audio.length}` }
            : {}),
        },
      });
    }
    return send(
      { error: { code: "UNEXPECTED_REQUEST", message: pathname } },
      500,
    );
  });
  await page.goto(`/#/meetings/${MEETING_ID}`);
  await expect(
    page.getByRole("heading", {
      name: meeting.title,
      exact: true,
    }),
  ).toBeVisible();
}

async function expectPartialTranscript(page: Page, hasDraftTasks = false) {
  await expect(
    page.getByRole("heading", { name: "Исходная запись", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Транскрипт", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(SEGMENT_TEXT, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Изменить имя говорящего: Голос 1" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Скачать PDF", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "DOCX", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Главное из встречи", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Поручения", exact: true }),
  ).toHaveCount(hasDraftTasks ? 1 : 0);
  await expect(
    page.getByText("Поручения не найдены", { exact: true }),
  ).toHaveCount(0);
  const audio = page.locator("audio");
  await expect(audio).toBeVisible();
  await expect
    .poll(() => audio.evaluate((node) => (node as HTMLAudioElement).readyState))
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Прослушать с 00:12: Голос 1" })
    .click();
  await expect
    .poll(() =>
      audio.evaluate((node) => (node as HTMLAudioElement).currentTime),
    )
    .toBe(12);
  await expect(page.locator("#segment-segment-saved")).toHaveAttribute(
    "aria-current",
    "true",
  );
}

test("failed extraction preserves saved transcript and audio, with error and read-only controls", async ({
  page,
}) => {
  await serveMeeting(page, fixture("failed"));
  await expect(
    page.getByRole("heading", {
      name: "Не удалось подготовить протокол",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Модель извлечения недоступна", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Последний этап: Извлечение поручений.", { exact: true }),
  ).toBeVisible();
  await expectPartialTranscript(page);
});

async function expectDraft(page: Page, state: "processing" | "failed") {
  await expect(
    page.getByText(
      state === "failed"
        ? "Черновик — проверка не завершена"
        : "Черновик, проверка продолжается",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator(".tasks-title")).toHaveText(TASK_TITLE);
  await expect(
    page.getByRole("button", { name: `Редактировать поручение: ${TASK_TITLE}` }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: `Показать источник поручения: ${TASK_TITLE}` }),
  ).toBeEnabled();
  await expect(
    page.getByRole("checkbox", { name: "Я проверил поручение по исходной записи" }),
  ).toHaveCount(0);
  await expect(page.getByText("100% точность", { exact: true })).toHaveCount(0);
  await expectPartialTranscript(page, true);
}

test("draft tasks stay read-only until partial processing becomes ready", async ({ page }) => {
  await page.clock.install();
  const meeting = draftFixture();
  const requests = { writes: 0 };
  await serveMeeting(page, meeting, requests);
  await expectDraft(page, "processing");
  await expect(page.getByText("Проверено реплик: 1 из 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Охват обработки, не оценка точности.", { exact: true })).toBeVisible();
  await expect(page.getByText("Дата не указана", { exact: true })).toBeVisible();
  await expect(page.getByText("«на следующей неделе»", { exact: true })).toBeVisible();
  await expect(page.getByText("Дата не определена", { exact: true })).toBeVisible();

  meeting.status = "ready";
  meeting.stage = "complete";
  meeting.progress = 100;
  meeting.extraction_checked_segments = 2;
  await page.clock.fastForward(2100);
  await expect(page.getByRole("heading", { name: "Главное из встречи", exact: true })).toBeVisible();
  await expect(page.locator(".tasks-title")).toHaveText(TASK_TITLE);
  await expect(page.getByText("Черновик, проверка продолжается", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Скачать PDF", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "DOCX", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: `Редактировать поручение: ${TASK_TITLE}` }).click();
  await expect(page.getByRole("checkbox", { name: "Я проверил поручение по исходной записи" })).toBeEnabled();
  expect(requests.writes).toBe(0);
});

test("coverage-check failure preserves draft tasks and transcript after polling", async ({ page }) => {
  await page.clock.install();
  const meeting = draftFixture();
  await serveMeeting(page, meeting);
  await expectDraft(page, "processing");

  meeting.status = "failed";
  meeting.error = { code: "COVERAGE_CHECK_FAILED", message: "coverage worker timed out" };
  await page.clock.fastForward(2100);
  await expectDraft(page, "failed");
  await expect(page.getByText(/Проверка полноты.*не заверш/)).toBeVisible();
  await expect(page.getByText("COVERAGE_CHECK_FAILED", { exact: true })).toBeVisible();
  await expect(page.getByText("Проверено реплик: 1 из 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Проверено человеком", { exact: true })).toHaveCount(0);
});

test("reload while extracting keeps saved draft and optional coverage metadata", async ({ page }) => {
  const meeting = draftFixture();
  await serveMeeting(page, meeting);
  await expectDraft(page, "processing");
  await page.reload();
  await expectDraft(page, "processing");
  await expect(page.getByText("Проверено реплик: 1 из 2", { exact: true })).toBeVisible();
});

for (const checked of [2, 999]) {
  test(`coverage ${checked} is bounded by available segments and never marks processing ready`, async ({ page }) => {
    const meeting = draftFixture();
    meeting.extraction_checked_segments = checked;
    meeting.progress = 100;
    await serveMeeting(page, meeting);
    await expect(page.getByText("Проверено реплик: 2 из 2", { exact: true })).toBeVisible();
    await expect(page.getByText("Охват обработки, не оценка точности.", { exact: true })).toBeVisible();
    await expectDraft(page, "processing");
    await expect(page.getByRole("heading", { name: "Главное из встречи", exact: true })).toHaveCount(0);
  });
}

test("older partial and ready records work without optional quality fields", async ({ page }) => {
  await page.clock.install();
  const meeting = draftFixture();
  delete meeting.extraction_checked_segments;
  delete meeting.tasks[0].evidence_quote;
  await serveMeeting(page, meeting);
  await expectDraft(page, "processing");
  await expect(page.getByText(/Проверено реплик:/)).toHaveCount(0);

  meeting.status = "ready";
  meeting.stage = "complete";
  await page.clock.fastForward(2100);
  await expect(page.locator(".tasks-title")).toHaveText(TASK_TITLE);
  await expect(page.getByRole("button", { name: "Скачать PDF", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: `Редактировать поручение: ${TASK_TITLE}` })).toBeEnabled();
});

test("network failure while polling retains real draft data and does not use demo records", async ({ page }) => {
  await page.clock.install();
  const meeting = draftFixture();
  const requests = { failReads: false, reads: 0 };
  await serveMeeting(page, meeting, requests);
  await expectDraft(page, "processing");
  requests.failReads = true;
  await page.clock.fastForward(2100);
  await expect.poll(() => requests.reads).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("alert").filter({ hasText: "Не удалось связаться с сервером" })).toBeVisible();
  await expectDraft(page, "processing");
  await expect(page.getByText("Демонстрационные данные", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: meeting.title, exact: true })).toBeVisible();
});

test("processing extraction exposes read-only transcript and enables results only after completion", async ({
  page,
}) => {
  await page.clock.install();
  const meeting = fixture("processing");
  await serveMeeting(page, meeting);
  await expect(
    page.getByRole("heading", { name: "Извлечение поручений", exact: true }),
  ).toBeVisible();
  await expectPartialTranscript(page);

  meeting.status = "ready";
  meeting.stage = "complete";
  meeting.progress = 100;
  await page.clock.fastForward(2100);
  await expect(
    page.getByRole("heading", { name: "Главное из встречи", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Изменить имя говорящего: Голос 1" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Скачать PDF", exact: true }),
  ).toBeEnabled();
});

test("failure before transcription shows its stage and does not invent a partial result", async ({
  page,
}) => {
  const meeting = fixture("failed");
  meeting.stage = "transcribe";
  meeting.progress = 15;
  meeting.error = {
    code: "TRANSCRIPTION_FAILED",
    message: "Не удалось распознать запись",
  };
  meeting.segments = [];
  meeting.speakers = [];
  await serveMeeting(page, meeting);
  await expect(
    page.getByRole("heading", {
      name: "Не удалось подготовить протокол",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Не удалось распознать запись", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Последний этап: Распознавание речи.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Транскрипт", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("audio")).toHaveCount(0);
  await expect(
    page.getByText("Поручения не найдены", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Скачать PDF", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "DOCX", exact: true }),
  ).toBeDisabled();
});

test("completed meeting without tasks shows the real empty state and permits export and speaker edits", async ({
  page,
}) => {
  await serveMeeting(page, fixture("ready"));
  await expect(
    page.getByRole("heading", { name: "Главное из встречи", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Поручения", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Поручения не найдены", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(SEGMENT_TEXT, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Изменить имя говорящего: Голос 1" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Скачать PDF", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "DOCX", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".processing-card")).toHaveCount(0);
});
