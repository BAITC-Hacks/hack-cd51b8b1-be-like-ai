import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type { Meeting } from "../src/types";

const run = promisify(execFile);
const token = process.env.MEETORA_INTEGRATION_TOKEN!;
const id = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const taskId = id(200);
const originalReasons = [
  "Срок зависит от события",
  "Нужно сверить условия согласования",
];

async function enterCode(page: Page, code: string, expectedStatus: number) {
  await page.getByLabel("Код доступа", { exact: true }).fill(code);
  const response = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" && item.url().endsWith("/api/session"),
  );
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  expect((await response).status()).toBe(expectedStatus);
}

async function openMeeting(page: Page, meetingId: string, title: string) {
  await page.goto(`/#/meetings/${meetingId}`);
  await expect(
    page.getByRole("heading", { name: title, exact: true, level: 1 }),
  ).toBeVisible();
}

async function login(
  page: Page,
  meetingId: string,
  title: string,
  checkWrongCode = false,
) {
  await page.goto(`/#/meetings/${meetingId}`);
  if (checkWrongCode) {
    await enterCode(page, "intentionally-invalid-test-code", 401);
    await expect(page.getByText(/Неверный код доступа/)).toBeVisible();
  }
  await enterCode(page, token, 200);
  await expect(page.getByLabel("Код доступа", { exact: true })).toHaveCount(0);
  // Production /login intentionally navigates to /; the Vite UI restores its hash.
  await openMeeting(page, meetingId, title);
  const session = (await page.context().cookies()).find(
    (cookie) => cookie.name === "hackalem_session",
  );
  expect(session).toMatchObject({ httpOnly: true, sameSite: "Strict" });
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "hackalem_session",
  );
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    token,
  );
  expect(
    await page.evaluate(() => JSON.stringify(sessionStorage)),
  ).not.toContain(token);
}

async function readMeeting(page: Page, meetingId: string): Promise<Meeting> {
  const response = await page.request.get(`/api/meetings/${meetingId}`);
  expect(response.status()).toBe(200);
  return response.json();
}

function taskResponse(page: Page, meetingId: string) {
  return page.waitForResponse(
    (item) =>
      item.request().method() === "PATCH" &&
      item.url().endsWith(`/api/meetings/${meetingId}/tasks/${taskId}`),
  );
}

test("real backend preserves event deadlines and speaker names; reload, sources and both exports retain edits", async ({
  page,
}, info) => {
  const number = info.project.name === "fastapi-production" ? 1 : 2;
  const meetingId = id(number);
  const title = `Интеграция ${number}`;
  await login(page, meetingId, title, true);
  const before = (await readMeeting(page, meetingId)).tasks[0];
  expect(before.deadline_kind).toBe("event");
  expect(before.review_reasons).toEqual(originalReasons);

  await page
    .getByRole("button", {
      name: "Редактировать поручение: Согласовать бюджет",
    })
    .click();
  const editor = page.getByRole("form", {
    name: "Редактирование: Согласовать бюджет",
  });
  // An older open draft must not undo a linked speaker's newly saved name.
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
  await expect(
    page.getByRole("button", {
      name: "Изменить имя говорящего: Алия Садыкова",
    }),
  ).toBeVisible();

  await editor
    .getByLabel("Статус", { exact: true })
    .selectOption("in_progress");
  const statusResponse = taskResponse(page, meetingId);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  const response = await statusResponse;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ status: "in_progress" });
  const after = (await readMeeting(page, meetingId)).tasks[0];
  expect(after).toMatchObject({
    status: "in_progress",
    deadline_kind: "event",
    due_date: null,
    deadline_text: before.deadline_text,
    assignee_name: "Алия Садыкова",
    assignee_speaker_id: id(100),
    reviewed: before.reviewed,
  });
  // Current backend also appends its generic unknown-calendar-date reason.
  // Require all original reasons to survive, without concealing that behavior.
  expect(after.review_reasons).toEqual(expect.arrayContaining(originalReasons));
  expect(after.review_reasons).not.toContain("Проверьте изменённое поручение");
  await expect(editor).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".tasks-status-in_progress")).toHaveText(
    "В работе",
  );
  await expect(page.locator(".tasks-assignee")).toHaveText("Алия Садыкова");
  for (const reason of originalReasons)
    await expect(page.getByText(reason, { exact: true })).toBeVisible();

  await page
    .getByRole("button", {
      name: "Редактировать поручение: Согласовать бюджет",
    })
    .click();
  await editor
    .getByLabel("Ответственный", { exact: true })
    .fill("Отдел закупок");
  await editor
    .getByLabel("Тип ответственного", { exact: true })
    .selectOption("department");
  const assigneeResponse = taskResponse(page, meetingId);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  const assigneeResult = await assigneeResponse;
  expect(assigneeResult.status()).toBe(200);
  expect(assigneeResult.request().postDataJSON()).toEqual({
    assignee_name: "Отдел закупок",
    assignee_type: "department",
    assignee_speaker_id: null,
  });
  await page.reload();
  await expect(page.locator(".tasks-assignee")).toHaveText("Отдел закупок");
  const saved = (await readMeeting(page, meetingId)).tasks[0];
  expect(saved).toMatchObject({
    assignee_name: "Отдел закупок",
    assignee_type: "department",
    assignee_speaker_id: null,
    deadline_kind: "event",
    deadline_text: "после получения сметы",
    status: "in_progress",
  });

  const audio = page.locator("audio");
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).readyState),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("searchbox", { name: "Поиск по тексту и имени говорящего" })
    .fill("Сначала");
  await page
    .getByRole("button", {
      name: "Показать источник поручения: Согласовать бюджет",
    })
    .click();
  await expect(page.locator(`#segment-${id(102)}`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator(`#segment-${id(102)}`)).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).currentTime),
    )
    .toBe(42);
  const range = await page.request.get(`/api/meetings/${meetingId}/audio`, {
    headers: { Range: "bytes=0-43" },
  });
  expect(range.status()).toBe(206);
  expect(range.headers()["content-range"]).toBe("bytes 0-43/1440044");
  expect((await range.body()).length).toBe(44);
  expect((await range.body()).subarray(0, 4).toString()).toBe("RIFF");

  const paths: Record<string, string> = {};
  for (const [format, button] of [
    ["pdf", "Скачать PDF"],
    ["docx", "DOCX"],
  ]) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: button, exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
      `protocol-${meetingId}.${format}`,
    );
    paths[format] = info.outputPath(`protocol.${format}`);
    await download.saveAs(paths[format]);
    expect(await download.failure()).toBeNull();
  }
  const verifier = fileURLToPath(
    new URL("./assert_exports.py", import.meta.url),
  );
  await run(process.env.MEETORA_TEST_PYTHON || "python", [
    verifier,
    paths.pdf,
    paths.docx,
    ...[
      "Согласовать бюджет",
      "Отдел закупок",
      "В работе",
      "после получения сметы",
      "Алия, согласуйте бюджет после получения сметы.",
    ].flatMap((value) => ["--contains", value]),
  ]);
});

test("expired real cookie prompts login and preserves draft until a manual retry; logout removes access", async ({
  page,
}, info) => {
  const number = info.project.name === "fastapi-production" ? 3 : 4;
  const meetingId = id(number);
  const title = `Интеграция ${number}`;
  await login(page, meetingId, title);
  await page
    .getByRole("button", {
      name: "Редактировать поручение: Согласовать бюджет",
    })
    .click();
  const editor = page.getByRole("form", {
    name: "Редактирование: Согласовать бюджет",
  });
  await editor
    .getByLabel("Поручение", { exact: true })
    .fill("Согласовать уточнённый бюджет");
  await page.context().clearCookies();
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().endsWith(`/tasks/${taskId}`)
    ) {
      requests.push(request.postDataJSON());
    }
  });
  const failed = taskResponse(page, meetingId);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await failed).status()).toBe(401);
  await expect(page.getByRole("dialog")).toBeVisible();
  await enterCode(page, "invalid-after-expiry", 401);
  await expect(page.getByText(/Неверный код доступа/)).toBeVisible();
  await enterCode(page, token, 200);
  await expect(page.getByLabel("Код доступа", { exact: true })).toHaveCount(0);
  await expect(editor.getByLabel("Поручение", { exact: true })).toHaveValue(
    "Согласовать уточнённый бюджет",
  );
  await expect(page).toHaveURL(new RegExp(`#/meetings/${meetingId}$`));
  // Reading the real server proves login did not automatically replay the write.
  expect((await readMeeting(page, meetingId)).tasks[0].title).toBe(
    "Согласовать бюджет",
  );
  expect(requests).toHaveLength(1);
  const retry = taskResponse(page, meetingId);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await retry).status()).toBe(200);
  expect(requests).toHaveLength(2);
  await page.reload();
  await expect(page.locator(".tasks-title")).toHaveText(
    "Согласовать уточнённый бюджет",
  );

  const logout = page.waitForResponse(
    (item) =>
      item.request().method() === "DELETE" &&
      item.url().endsWith("/api/session"),
  );
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  expect((await logout).status()).toBe(200);
  expect(
    (await page.context().cookies()).some(
      (cookie) => cookie.name === "hackalem_session",
    ),
  ).toBe(false);
  expect((await page.request.get(`/api/meetings/${meetingId}`)).status()).toBe(
    401,
  );
});

test("saved partial transcript remains accessible and read-only; early failure differs from ready with no tasks", async ({
  page,
}) => {
  await login(page, id(10), "Ошибка после распознавания");
  for (const [number, title] of [
    [10, "Ошибка после распознавания"],
    [11, "Извлечение поручений"],
  ] as const) {
    await openMeeting(page, id(number), title);
    await expect(page.locator(`#segment-${id(102)}`)).toBeVisible();
    await expect(page.locator("audio")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Изменить имя говорящего: Алия" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /Редактировать поручение:/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Поручения не найдены", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Скачать PDF", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "DOCX", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".processing-card")).toContainText(
      "Извлечение поручений",
    );
    if (number === 10)
      await expect(
        page.getByText("Синтетическая ошибка извлечения", { exact: true }),
      ).toBeVisible();
  }
  await openMeeting(page, id(12), "Ошибка до распознавания");
  await expect(
    page.getByText("Синтетическая ошибка декодирования", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".transcript-segment")).toHaveCount(0);
  await expect(page.locator("audio")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Поручения не найдены", exact: true }),
  ).toHaveCount(0);
  await openMeeting(page, id(13), "Готово без поручений");
  await expect(
    page.getByRole("heading", { name: "Поручения не найдены", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".processing-card")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Скачать PDF", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Изменить имя говорящего: Алия" }),
  ).toBeEnabled();
});
