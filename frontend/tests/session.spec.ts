import { expect, test, type Page } from "@playwright/test";
import type { Meeting, TaskPatch } from "../src/types";

const meetingId = "921beaa9-f8ea-4a71-809e-73423eadc336";
const code = "synthetic-session-test";
function meeting(): Meeting {
  return {
    id: meetingId,
    title: "Проверка восстановления сессии",
    started_at: null,
    created_at: "2026-09-23T09:00:00Z",
    timezone: "Asia/Almaty",
    duration_seconds: null,
    status: "ready",
    stage: "complete",
    progress: null,
    error: null,
    speakers: [
      {
        id: "speaker",
        label: "SPEAKER_00",
        display_name: "Спикер 1",
        identification: "unknown",
      },
    ],
    segments: [
      {
        id: "segment",
        start: 1,
        end: 5,
        speaker_id: "speaker",
        text: "Подготовить материалы после согласования.",
        needs_review: false,
      },
    ],
    summary: {
      overview: "План подготовки материалов.",
      decisions: [],
      risks: [],
    },
    tasks: [
      {
        id: "task",
        title: "Подготовить материалы",
        description: "",
        assignee_name: "Координатор",
        assignee_type: "person",
        assignee_speaker_id: null,
        deadline_text: "после согласования",
        deadline_kind: "event",
        due_date: null,
        status: "open",
        is_overdue: false,
        evidence_segment_ids: ["segment"],
        needs_review: true,
        review_reasons: ["Уточнить событие"],
        reviewed: false,
      },
    ],
  };
}

async function server(page: Page, initiallyAuthorized: boolean) {
  const state = {
    authorized: initiallyAuthorized,
    meeting: meeting(),
    patches: [] as TaskPatch[],
    uploads: 0,
    logouts: 0,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/health")
      return json({
        status: "ok",
        models: { asr: true, diarization: true, extraction: true },
      });
    if (path === "/api/session") {
      if (request.method() === "DELETE") {
        state.authorized = false;
        state.logouts++;
        return json({ status: "ok" });
      }
      if (request.postDataJSON().token !== code)
        return json(
          { error: { code: "UNAUTHORIZED", message: "Неверный код доступа." } },
          401,
        );
      state.authorized = true;
      return json({ status: "ok" });
    }
    if (path === "/api/meetings" && request.method() === "POST")
      state.uploads++;
    if (request.method() === "PATCH")
      state.patches.push(request.postDataJSON() as TaskPatch);
    if (!state.authorized)
      return json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Требуется код доступа к приложению.",
          },
        },
        401,
      );
    if (path === "/api/meetings" && request.method() === "POST")
      return json({ meeting_id: meetingId, status: "queued" }, 202);
    if (path === "/api/meetings") return json({ items: [state.meeting] });
    if (path.endsWith("/audio")) return route.fulfill({ status: 204 });
    if (request.method() === "PATCH") {
      Object.assign(state.meeting.tasks[0], request.postDataJSON());
      return json(state.meeting.tasks[0]);
    }
    return json(state.meeting);
  });
  return state;
}

async function login(page: Page) {
  await page.getByLabel("Код доступа", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Вход в рабочее пространство" }),
  ).toHaveCount(0);
}

test("401 opens login; wrong code is visible; login restores route and logout ends access", async ({
  page,
}) => {
  const state = await server(page, false);
  await page.goto(`/#/meetings/${meetingId}`);
  await page.getByLabel("Код доступа", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Неверный код",
  );
  await login(page);
  await expect(
    page.getByRole("heading", { name: state.meeting.title }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(meetingId));
  const storage = await page.evaluate(() =>
    JSON.stringify([localStorage, sessionStorage]),
  );
  expect(storage).not.toContain(code);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Вход в рабочее пространство" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: state.meeting.title }),
  ).toHaveCount(0);
  expect(state.logouts).toBe(1);
});

test("session expiry during PATCH preserves the draft and never automatically repeats saving", async ({
  page,
}) => {
  const state = await server(page, true);
  await page.goto(`/#/meetings/${meetingId}`);
  await page
    .getByRole("button", {
      name: "Редактировать поручение: Подготовить материалы",
    })
    .click();
  const editor = page.getByRole("form", {
    name: "Редактирование: Подготовить материалы",
  });
  await editor
    .getByLabel("Поручение", { exact: true })
    .fill("Материалы для проверки");
  state.authorized = false;
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await login(page);
  await expect(editor.getByLabel("Поручение", { exact: true })).toHaveValue(
    "Материалы для проверки",
  );
  await expect(
    page.getByRole("button", { name: "Скачать PDF" }),
  ).toBeDisabled();
  expect(state.patches).toHaveLength(1);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Изменения поручения сохранены.")).toBeVisible();
  expect(state.patches).toHaveLength(2);
  expect(state.meeting.tasks[0].title).toBe("Материалы для проверки");
});

test("upload session recovery keeps the chosen file and requires manual resubmission", async ({
  page,
}) => {
  const state = await server(page, true);
  await page.goto(`/#/meetings/${meetingId}`);
  await page.getByRole("button", { name: "Новое совещание" }).click();
  const upload = page.getByRole("dialog", { name: "От записи к поручениям" });
  await upload.getByLabel("Название совещания").fill("Запись после входа");
  await upload
    .getByLabel("Аудиозапись MP3 или WAV")
    .setInputFiles({
      name: "synthetic.wav",
      mimeType: "audio/wav",
      buffer: Buffer.from("synthetic test fixture"),
    });
  await upload.getByRole("checkbox").check();
  state.authorized = false;
  await upload.getByRole("button", { name: "Создать протокол" }).click();
  await login(page);
  await expect(upload.getByLabel("Название совещания")).toHaveValue(
    "Запись после входа",
  );
  await expect(
    upload.getByText("synthetic.wav", { exact: true }),
  ).toBeVisible();
  expect(state.uploads).toBe(1);
  await upload.getByRole("button", { name: "Создать протокол" }).click();
  await expect(upload).toHaveCount(0);
  expect(state.uploads).toBe(2);
});
