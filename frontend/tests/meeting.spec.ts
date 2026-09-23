import { expect, test, type Page } from "@playwright/test";
import type { Meeting, TaskPatch } from "../src/types";

const MEETING_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

function fixture(id = MEETING_ID): Meeting {
  return {
    id,
    title: id === MEETING_ID ? "План запуска пилота" : "Следующее совещание",
    started_at: null,
    created_at: "2026-09-23T05:00:00Z",
    status: "ready",
    timezone: "Asia/Almaty",
    duration_seconds: 120,
    stage: "complete",
    progress: 100,
    error: null,
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
        id: "segment-early",
        start: 3,
        end: 12,
        speaker_id: "speaker-1",
        text: "Сначала обсудим бюджет проекта.",
        needs_review: false,
      },
      {
        id: "segment-evidence",
        start: 42,
        end: 54,
        speaker_id: "speaker-1",
        text: "Алия, подготовьте смету к пятнице.",
        needs_review: false,
      },
    ],
    summary: {
      overview: "Обсудили подготовку пилота.",
      decisions: ["Подготовить смету"],
      risks: ["Дата встречи неизвестна"],
    },
    tasks: [
      {
        id: "task-1",
        title: "Подготовить смету",
        description: "Собрать стоимость пилота",
        assignee_name: "Алия",
        assignee_type: "person",
        assignee_speaker_id: null,
        deadline_text: "к пятнице",
        deadline_kind: "relative",
        due_date: null,
        status: "open",
        is_overdue: false,
        evidence_segment_ids: ["segment-evidence"],
        needs_review: true,
        review_reasons: ["Неизвестна дата встречи"],
        reviewed: false,
      },
    ],
  };
}

function wav() {
  const rate = 8000;
  const length = rate * 120 * 2;
  const result = Buffer.alloc(44 + length);
  result.write("RIFF", 0);
  result.writeUInt32LE(36 + length, 4);
  result.write("WAVE", 8);
  result.write("fmt ", 12);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(rate, 24);
  result.writeUInt32LE(rate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(length, 40);
  return result;
}

type ApiOptions = {
  meetings?: Meeting[];
  readFailure?: boolean;
  patchFailure?: boolean;
  onRead?: (id: string) => void;
  onUpload?: (body: string) => void;
  onExport?: () => void;
};

async function mockApi(page: Page, options: ApiOptions = {}) {
  const meetings = structuredClone(options.meetings ?? [fixture()]);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const send = (json: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(json),
      });
    if (pathname === "/api/health")
      return send({
        status: "ok",
        models: { asr: true, diarization: true, extraction: true },
      });
    if (pathname === "/api/meetings" && method === "GET")
      return send({
        items: meetings.map(
          ({ id, title, started_at, created_at, status }) => ({
            id,
            title,
            started_at,
            created_at,
            status,
          }),
        ),
      });
    if (pathname === "/api/meetings" && method === "POST") {
      options.onUpload?.(request.postData() ?? "");
      return send(
        { meeting_id: meetings[0]?.id ?? MEETING_ID, status: "queued" },
        202,
      );
    }
    const match = /^\/api\/meetings\/([^/]+)(.*)$/.exec(pathname);
    const meeting = meetings.find((item) => item.id === match?.[1]);
    if (!meeting || !match)
      return send({ error: { code: "NOT_FOUND", message: "Не найдено" } }, 404);
    if (!match[2]) {
      options.onRead?.(meeting.id);
      return options.readFailure
        ? send(
            {
              error: {
                code: "MODEL_UNAVAILABLE",
                message: "Сервис распознавания недоступен",
              },
            },
            503,
          )
        : send(meeting);
    }
    if (match[2] === "/audio") {
      const audio = wav();
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2]
          ? Math.min(Number(range[2]), audio.length - 1)
          : audio.length - 1;
        return route.fulfill({
          status: 206,
          contentType: "audio/wav",
          body: audio.subarray(start, end + 1),
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${audio.length}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: audio,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(audio.length),
        },
      });
    }
    if (match[2] === "/export") {
      options.onExport?.();
      return route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: "%PDF-1.4\n%%EOF",
        headers: {
          "Content-Disposition": 'attachment; filename="protocol.pdf"',
        },
      });
    }
    if (method === "PATCH" && match[2].startsWith("/tasks/")) {
      if (options.patchFailure)
        return send(
          {
            error: {
              code: "SAVE_FAILED",
              message: "Не удалось записать изменения на сервере",
            },
          },
          500,
        );
      const task = meeting.tasks.find(
        (item) => item.id === match[2].slice("/tasks/".length),
      );
      if (!task)
        return send(
          { error: { code: "NOT_FOUND", message: "Поручение не найдено" } },
          404,
        );
      Object.assign(task, request.postDataJSON() as TaskPatch);
      return send(task);
    }
    if (method === "PATCH" && match[2].startsWith("/speakers/")) {
      const speaker = meeting.speakers.find(
        (item) => item.id === match[2].slice("/speakers/".length),
      );
      if (!speaker)
        return send(
          { error: { code: "NOT_FOUND", message: "Говорящий не найден" } },
          404,
        );
      Object.assign(speaker, request.postDataJSON(), {
        identification: "confirmed",
      });
      return send(speaker);
    }
    return send(
      {
        error: { code: "UNEXPECTED_REQUEST", message: `${method} ${pathname}` },
      },
      500,
    );
  });
}

async function openMeeting(page: Page) {
  await page.goto(`/#/meetings/${MEETING_ID}`);
  await expect(
    page.getByRole("heading", { name: "План запуска пилота", exact: true }),
  ).toBeVisible();
}

test("API failure stays visible and never falls back to demonstration data", async ({
  page,
}) => {
  await mockApi(page, { readFailure: true });
  await page.goto(`/#/meetings/${MEETING_ID}`);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Сервис распознавания недоступен" }),
  ).toBeVisible();
  await expect(
    page.getByText("Демонстрационные данные", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "План запуска пилота", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Показать источник поручения/ }),
  ).toHaveCount(0);
});

test("upload with an unknown meeting date omits started_at and sends consent", async ({
  page,
}) => {
  let uploadedBody = "";
  await mockApi(page, {
    onUpload: (body) => {
      uploadedBody = body;
    },
  });
  await page.goto("/#/");
  await page.getByRole("button", { name: "Новое совещание" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название совещания").fill("Новая запись");
  await dialog
    .getByLabel("Аудиозапись MP3 или WAV")
    .setInputFiles({
      name: "meeting.wav",
      mimeType: "audio/wav",
      buffer: wav().subarray(0, 100),
    });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Создать протокол" }).click();
  await expect
    .poll(() => uploadedBody)
    .toContain('name="file"; filename="meeting.wav"');
  expect(uploadedBody).toContain('name="title"');
  expect(uploadedBody).toContain("Новая запись");
  expect(uploadedBody).toContain('name="participants_notified"\r\n\r\ntrue');
  expect(uploadedBody).toContain('name="timezone"\r\n\r\nAsia/Almaty');
  expect(uploadedBody).not.toContain('name="started_at"');
  await expect(dialog).toHaveCount(0);
});

test("failed PATCH leaves draft open, original title intact and an adjacent error", async ({
  page,
}) => {
  await mockApi(page, { patchFailure: true });
  await openMeeting(page);
  await page
    .getByRole("button", { name: "Редактировать поручение: Подготовить смету" })
    .click();
  const form = page.getByRole("form", {
    name: "Редактирование: Подготовить смету",
  });
  await form
    .getByLabel("Поручение", { exact: true })
    .fill("Отредактированный заголовок");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Не удалось записать изменения на сервере",
  );
  await expect(form.getByLabel("Поручение", { exact: true })).toHaveValue(
    "Отредактированный заголовок",
  );
  await expect(page.locator(".tasks-title")).toHaveText("Подготовить смету");
  await expect(
    page.getByText("Изменения поручения сохранены.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Скачать PDF", exact: true }),
  ).toBeDisabled();
});

test("evidence selects the referenced segment and seeks its exact start through search", async ({
  page,
}) => {
  await mockApi(page);
  await openMeeting(page);
  const audio = page.locator("audio");
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).readyState),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("searchbox", { name: "Поиск по тексту и имени говорящего" })
    .fill("бюджет");
  await expect(page.locator("#segment-segment-evidence")).toBeHidden();
  await page
    .getByRole("button", {
      name: "Показать источник поручения: Подготовить смету",
    })
    .click();
  await expect(page.locator("#segment-segment-evidence")).toBeVisible();
  await expect(page.locator("#segment-segment-evidence")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).currentTime),
    )
    .toBe(42);
  await expect(page.locator("#segment-segment-early")).not.toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("missing sources are explicit and partial evidence selects the first available reference", async ({
  page,
}) => {
  const meeting = fixture();
  meeting.tasks[0].evidence_segment_ids = [
    "missing-evidence",
    "segment-evidence",
  ];
  meeting.tasks.push({
    ...meeting.tasks[0],
    id: "task-missing",
    title: "Поручение без подтверждения",
    evidence_segment_ids: ["another-missing-id"],
  });
  await mockApi(page, { meetings: [meeting] });
  await openMeeting(page);
  const missingRow = page
    .getByRole("row")
    .filter({ hasText: "Поручение без подтверждения" });
  await expect(
    missingRow.getByText("Источник недоступен", { exact: true }),
  ).toBeVisible();
  await expect(
    missingRow.getByRole("button", { name: /Показать источник/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Показать источник поручения: Подготовить смету",
    })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Часть подтверждающих реплик отсутствует" }),
  ).toBeVisible();
  await expect(page.locator("#segment-segment-evidence")).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("processing polling stops after switching to another meeting", async ({
  page,
}) => {
  await page.clock.install();
  const first = fixture();
  first.status = "processing";
  first.stage = "transcribe";
  first.progress = null;
  const second = fixture(OTHER_ID);
  const reads: Record<string, number> = {};
  await mockApi(page, {
    meetings: [first, second],
    onRead: (id) => {
      reads[id] = (reads[id] ?? 0) + 1;
    },
  });
  await openMeeting(page);
  await expect(
    page.getByRole("heading", { name: "Распознавание речи", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(2100);
  await expect.poll(() => reads[MEETING_ID]).toBeGreaterThanOrEqual(2);
  await page
    .getByRole("navigation", { name: "Совещания", exact: true })
    .getByRole("button", { name: /Следующее совещание/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Следующее совещание", exact: true }),
  ).toBeVisible();
  const countAfterSwitch = reads[MEETING_ID];
  await page.clock.fastForward(6100);
  await expect(
    page.getByRole("heading", { name: "Следующее совещание", exact: true }),
  ).toBeVisible();
  expect(reads[MEETING_ID]).toBe(countAfterSwitch);
});

test("task and speaker drafts prevent export until saved or cancelled", async ({
  page,
}) => {
  let exports = 0;
  await mockApi(page, {
    onExport: () => {
      exports += 1;
    },
  });
  await openMeeting(page);
  const pdf = page.getByRole("button", { name: "Скачать PDF", exact: true });
  const docx = page.getByRole("button", { name: "DOCX", exact: true });
  await expect(pdf).toBeEnabled();
  await page
    .getByRole("button", { name: "Редактировать поручение: Подготовить смету" })
    .click();
  await expect(pdf).toBeDisabled();
  await expect(docx).toBeDisabled();
  await page
    .getByRole("form", { name: "Редактирование: Подготовить смету" })
    .getByRole("button", { name: "Отмена" })
    .click();
  await expect(pdf).toBeEnabled();
  await page
    .getByRole("button", { name: "Изменить имя говорящего: Голос 1" })
    .click();
  await page.getByLabel("Имя говорящего", { exact: true }).fill("Бекзат");
  await expect(pdf).toBeDisabled();
  await expect(docx).toBeDisabled();
  await page
    .locator(".transcript-name-form")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Изменить имя говорящего: Бекзат" }),
  ).toBeVisible();
  await expect(pdf).toBeEnabled();
  await expect(page.locator(".tasks-assignee")).toHaveText("Алия");
  expect(exports).toBe(0);
});

test("changing assignee clears the old voice link and departments cannot link to speakers", async ({
  page,
}) => {
  const meeting = fixture();
  meeting.tasks[0].assignee_speaker_id = "speaker-1";
  await mockApi(page, { meetings: [meeting] });
  await openMeeting(page);
  await page
    .getByRole("button", { name: "Редактировать поручение: Подготовить смету" })
    .click();
  const form = page.getByRole("form", {
    name: "Редактирование: Подготовить смету",
  });
  const speakerSelect = form.getByLabel(/Связь с голосом в записи/);
  await expect(speakerSelect).toHaveValue("speaker-1");
  await form.getByLabel("Ответственный", { exact: true }).fill("Мария");
  await expect(speakerSelect).toHaveValue("");
  await speakerSelect.selectOption("speaker-1");
  await form
    .getByLabel("Тип ответственного", { exact: true })
    .selectOption("department");
  await expect(speakerSelect).toBeDisabled();
  await expect(speakerSelect).toHaveValue("");
  await form.getByLabel("Ответственный", { exact: true }).fill("Отдел закупок");
  const patchRequest = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && request.url().endsWith("/tasks/task-1"),
  );
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await patchRequest).postDataJSON()).toMatchObject({
    assignee_name: "Отдел закупок",
    assignee_type: "department",
    assignee_speaker_id: null,
  });
  await expect(page.locator(".tasks-assignee")).toHaveText("Отдел закупок");
});

test("reviewed checkbox does not hide unresolved backend review reasons", async ({
  page,
}) => {
  const meeting = fixture();
  meeting.tasks[0].reviewed = true;
  await mockApi(page, { meetings: [meeting] });
  await openMeeting(page);
  await expect(
    page.getByText("Проверено человеком", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Нужно уточнить", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Неизвестна дата встречи", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Уточнить 1/ }).click();
  await expect(page.locator(".tasks-title")).toHaveText("Подготовить смету");
});
