import { expect, test, type Page } from "@playwright/test";
import type { Meeting, Speaker } from "../src/types";

const MEETING_ID = "00000000-0000-4000-8000-000000000041";

function fixture(): Meeting {
  return {
    id: MEETING_ID,
    title: "Проверка имён говорящих",
    started_at: null,
    created_at: "2026-09-23T05:00:00Z",
    status: "ready",
    timezone: "Asia/Almaty",
    duration_seconds: 30,
    stage: "complete",
    progress: 100,
    error: null,
    speakers: [{
      id: "speaker-1",
      label: "SPEAKER_00",
      display_name: "Алия",
      identification: "suggested",
    }],
    segments: [{
      id: "segment-1",
      start: 0,
      end: 10,
      speaker_id: "speaker-1",
      text: "Согласуем итоговый план на следующей неделе.",
      needs_review: false,
    }],
    summary: { overview: "Обсуждение плана", decisions: [], risks: [] },
    tasks: [],
  };
}

async function serveMeeting(
  page: Page,
  meeting: Meeting,
  patch?: (body: { display_name: string }) => Promise<Speaker | null>,
) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
    if (pathname === "/api/health") return send({
      status: "ok",
      models: { asr: true, diarization: true, extraction: true },
    });
    if (pathname === "/api/meetings") return send({ items: [meeting] });
    if (pathname === `/api/meetings/${MEETING_ID}`) return send(meeting);
    if (pathname.endsWith("/audio")) return route.fulfill({ status: 204 });
    if (request.method() === "PATCH" && pathname.endsWith("/speakers/speaker-1")) {
      const updated = await patch?.(request.postDataJSON());
      if (!updated) return send({
        error: { code: "SAVE_FAILED", message: "Не удалось сохранить имя" },
      }, 500);
      meeting.speakers[0] = updated;
      return send(updated);
    }
    return send({ error: { code: "UNEXPECTED_REQUEST", message: pathname } }, 500);
  });
  await page.goto(`/#/meetings/${MEETING_ID}`);
  await expect(page.getByRole("heading", { name: meeting.title, exact: true })).toBeVisible();
}

test("suggested name is only confirmed after a successful PATCH, including on reload", async ({ page }) => {
  const meeting = fixture();
  const patches: unknown[] = [];
  let release!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  await serveMeeting(page, meeting, async (body) => {
    patches.push(body);
    await response;
    return { ...meeting.speakers[0], ...body, identification: "confirmed" };
  });
  const speaker = page.locator(".transcript-speaker-card");
  await expect(speaker.getByText("Имя предложено ИИ", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Подтвердить или исправить имя: Алия" }).click();
  await expect(speaker.getByLabel("Имя говорящего", { exact: true })).toHaveValue("Алия");
  await speaker.getByRole("button", { name: "Подтвердить имя", exact: true }).click();
  await expect.poll(() => patches).toEqual([{ display_name: "Алия" }]);
  await expect(speaker.getByText("Имя предложено ИИ", { exact: true })).toBeVisible();
  await expect(speaker.getByText("Имя подтверждено", { exact: true })).toHaveCount(0);
  release();
  await expect(speaker.getByText("Имя подтверждено", { exact: true })).toBeVisible();
  await page.reload();
  await expect(speaker.getByText("Имя подтверждено", { exact: true })).toBeVisible();
});

test("failed correction keeps suggested state and the corrected draft for retry", async ({ page }) => {
  const meeting = fixture();
  const patches: unknown[] = [];
  await serveMeeting(page, meeting, async (body) => {
    patches.push(body);
    return null;
  });
  const speaker = page.locator(".transcript-speaker-card");
  await page.getByRole("button", { name: "Подтвердить или исправить имя: Алия" }).click();
  await speaker.getByLabel("Имя говорящего", { exact: true }).fill("Алия Садыкова");
  await speaker.getByRole("button", { name: "Подтвердить имя", exact: true }).click();
  await expect(speaker.getByRole("alert")).toHaveText("Не удалось сохранить имя");
  expect(patches).toEqual([{ display_name: "Алия Садыкова" }]);
  await expect(speaker.getByLabel("Имя говорящего", { exact: true })).toHaveValue("Алия Садыкова");
  await expect(speaker.getByText("Имя предложено ИИ", { exact: true })).toBeVisible();
  await expect(speaker.getByText("Имя подтверждено", { exact: true })).toHaveCount(0);
});

test("a numbered technical label is never presented as an established name", async ({ page }) => {
  const meeting = fixture();
  meeting.speakers[0].display_name = "Спикер 1";
  meeting.speakers[0].identification = "confirmed";
  await serveMeeting(page, meeting);
  const speaker = page.locator(".transcript-speaker-card");
  await expect(speaker.getByText("Техническая метка · имя не установлено", { exact: true })).toBeVisible();
  await expect(page.locator(".transcript-segment").getByText("имя не установлено", { exact: true })).toBeVisible();
  await expect(speaker.getByText("Имя подтверждено", { exact: true })).toHaveCount(0);
});

for (const status of ["processing", "failed"] as const) {
  test(`suggested names remain visible and read-only while ${status}`, async ({ page }) => {
    const meeting = fixture();
    meeting.status = status;
    meeting.stage = "extract";
    meeting.progress = 80;
    if (status === "failed") meeting.error = { code: "EXTRACTION_FAILED", message: "Ошибка извлечения" };
    await serveMeeting(page, meeting);
    const speaker = page.locator(".transcript-speaker-card");
    await expect(speaker.getByText("Имя предложено ИИ", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Подтвердить или исправить имя: Алия" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Изменить имя говорящего: Алия" })).toBeDisabled();
  });
}
