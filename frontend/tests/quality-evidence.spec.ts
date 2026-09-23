import { expect, test, type Page } from "@playwright/test";
import type { Meeting } from "../src/types";

const MEETING_ID = "00000000-0000-4000-8000-000000000051";
const TASK_TITLE = "Проверить готовность площадок";
const DESCRIPTION = "Проверить все площадки северного и южного филиалов после получения допуска.\nПри выявлении замечаний согласовать сроки устранения с руководителями. Подготовить отдельный отчёт с фотографиями по каждой площадке.";

function fixture(): Meeting {
  return {
    id: MEETING_ID,
    title: "Проверка оснований поручений",
    started_at: null,
    created_at: "2026-09-23T05:00:00Z",
    status: "ready",
    stage: "complete",
    progress: 100,
    timezone: "Asia/Almaty",
    duration_seconds: 90,
    error: null,
    speakers: [{ id: "speaker-1", label: "SPEAKER_00", display_name: "Алия", identification: "suggested" }],
    segments: [
      { id: "segment-1", start: 12, end: 23, speaker_id: "speaker-1", text: "На следующей неделе проверьте все площадки после получения допуска.", needs_review: false },
      { id: "segment-2", start: 42, end: 53, speaker_id: "speaker-1", text: "И обязательно подготовьте отчёт с фотографиями по каждой площадке.", needs_review: false },
    ],
    summary: { overview: "Обсудили проверку площадок.", decisions: [], risks: [] },
    tasks: [{
      id: "task-1",
      title: TASK_TITLE,
      description: DESCRIPTION,
      assignee_name: "Алия",
      assignee_type: "person",
      assignee_speaker_id: "speaker-1",
      deadline_text: "на следующей неделе",
      deadline_kind: "relative",
      due_date: null,
      status: "open",
      is_overdue: false,
      evidence_segment_ids: ["segment-1", "missing-segment", "segment-2"],
      evidence_quote: "Проверьте все площадки после получения допуска. Подготовьте отчёт с фотографиями.",
      needs_review: true,
      review_reasons: ["Неизвестна дата записи"],
      reviewed: true,
    }],
  };
}

function wav() {
  const rate = 8000;
  const length = rate * 90 * 2;
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

async function openMeeting(page: Page, meeting: Meeting) {
  const mutations: string[] = [];
  const audio = wav();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") mutations.push(path);
    if (path === "/api/health") return route.fulfill({ json: { status: "ok", models: { asr: true, diarization: true, extraction: true } } });
    if (path === "/api/meetings") return route.fulfill({ json: { items: [meeting] } });
    if (path === `/api/meetings/${MEETING_ID}`) return route.fulfill({ json: meeting });
    if (path.endsWith("/audio")) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        body: audio.subarray(start, end + 1),
        headers: { "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), ...(range ? { "Content-Range": `bytes ${start}-${end}/${audio.length}` } : {}) },
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`/#/meetings/${MEETING_ID}`);
  await expect(page.getByRole("heading", { name: meeting.title, exact: true })).toBeVisible();
  return mutations;
}

for (const width of [1440, 390]) {
  test(`evidence keeps full conditions, quote and multiple source jumps at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const meeting = fixture();
    await openMeeting(page, meeting);
    await expect(page.locator(".tasks-description")).toHaveText(DESCRIPTION);
    await expect(page.locator(".tasks-deadline-original")).toHaveText("«на следующей неделе»");
    await expect(page.locator(".tasks-data-row")).toContainText("Дата не определена");
    await expect(page.locator('.tasks-data-row td[data-label="Ответственный"]')).toContainText("Имя предложено ИИ");
    const source = page.getByRole("button", { name: `Показать источник поручения: ${TASK_TITLE}` });
    await source.click();
    await expect(source).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#segment-segment-1")).toHaveAttribute("aria-current", "true");
    const evidence = page.getByRole("region", { name: `Источник поручения: ${TASK_TITLE}` });
    await expect(evidence.locator("blockquote")).toHaveText(meeting.tasks[0].evidence_quote!);
    for (const segment of meeting.segments) await expect(evidence.getByText(segment.text, { exact: true })).toBeVisible();
    await expect(evidence.getByText("Реплика 2 недоступна в сохранённой расшифровке.", { exact: true })).toBeVisible();
    await expect(evidence.getByText("Имя предложено ИИ", { exact: true })).toHaveCount(2);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`evidence-${width}.png`), fullPage: true });
    const table = page.locator(".tasks-table-scroll");
    const tableSizes = await table.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(tableSizes.scroll).toBeLessThanOrEqual(tableSizes.client);
    const panelBounds = await table.boundingBox();
    expect(panelBounds).not.toBeNull();
    for (const jump of await evidence.getByRole("button", { name: /К реплике/ }).all()) {
      const jumpBounds = await jump.boundingBox();
      expect(jumpBounds).not.toBeNull();
      expect(jumpBounds!.x).toBeGreaterThanOrEqual(panelBounds!.x - 1);
      expect(jumpBounds!.x + jumpBounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1);
    }
    await evidence.getByRole("button", { name: `К реплике 3 и аудио 00:42: ${TASK_TITLE}` }).click();
    await expect(page.locator("#segment-segment-2")).toHaveAttribute("aria-current", "true");
    await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(42, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await source.click();
    await expect(evidence).toHaveCount(0);
    await expect(source).toHaveAttribute("aria-expanded", "false");
  });
}

test("older tasks without a quote still disclose original replicas", async ({ page }) => {
  const meeting = fixture();
  delete meeting.tasks[0].evidence_quote;
  await openMeeting(page, meeting);
  await page.getByRole("button", { name: `Показать источник поручения: ${TASK_TITLE}` }).click();
  const evidence = page.getByRole("region", { name: `Источник поручения: ${TASK_TITLE}` });
  await expect(evidence.getByText("Отдельная цитата не сохранена. Проверьте исходные реплики.")).toBeVisible();
  await expect(evidence.locator("blockquote")).toHaveCount(0);
  await expect(evidence.getByRole("button", { name: /К реплике/ })).toHaveCount(2);
});

test("a quote without source references is readable without an invalid audio jump", async ({ page }) => {
  const meeting = fixture();
  meeting.tasks[0].evidence_segment_ids = [];
  await openMeeting(page, meeting);
  await page.getByRole("button", { name: `Показать источник поручения: ${TASK_TITLE}` }).click();
  const evidence = page.getByRole("region", { name: `Источник поручения: ${TASK_TITLE}` });
  await expect(evidence.locator("blockquote")).toHaveText(meeting.tasks[0].evidence_quote!);
  await expect(evidence.getByText("Связь с репликами не сохранена. Переход к фрагменту аудио недоступен.")).toBeVisible();
  await expect(evidence.getByRole("button", { name: /К реплике/ })).toHaveCount(0);
  await expect(page.locator(".transcript-segment[aria-current=true]")).toHaveCount(0);
});

test("technical speaker labels never imply an established identity in task sources", async ({ page }) => {
  const meeting = fixture();
  meeting.speakers[0].display_name = "Спикер 1";
  meeting.speakers[0].identification = "confirmed";
  meeting.tasks[0].assignee_name = "Спикер 1";
  await openMeeting(page, meeting);
  await expect(page.locator('.tasks-data-row td[data-label="Ответственный"]')).toContainText("Имя не установлено");
  await page.getByRole("button", { name: `Показать источник поручения: ${TASK_TITLE}` }).click();
  const evidence = page.getByRole("region", { name: `Источник поручения: ${TASK_TITLE}` });
  await expect(evidence.getByText("Спикер 1", { exact: true })).toHaveCount(2);
  await expect(evidence.getByText("Имя не установлено", { exact: true })).toHaveCount(2);
  await expect(evidence.getByText("Имя подтверждено", { exact: true })).toHaveCount(0);
});

test("human correction of conditions patches only the description and invalidates previous review", async ({ page }) => {
  const meeting = fixture();
  await openMeeting(page, meeting);
  const patches: unknown[] = [];
  await page.route("**/api/meetings/*/tasks/task-1", async (route) => {
    const patch = route.request().postDataJSON();
    patches.push(patch);
    Object.assign(meeting.tasks[0], patch);
    // Match backend/app.py: substantive changes invalidate review unless the
    // PATCH explicitly carries a fresh human review decision.
    if (Object.keys(patch).some((key) => key !== "status" && key !== "reviewed") && !("reviewed" in patch)) {
      meeting.tasks[0].reviewed = false;
    }
    return route.fulfill({ json: meeting.tasks[0] });
  });
  await page.getByRole("button", { name: `Редактировать поручение: ${TASK_TITLE}` }).click();
  const form = page.getByRole("form", { name: `Редактирование: ${TASK_TITLE}` });
  await expect(form.getByLabel("Подробности", { exact: true })).toHaveValue(DESCRIPTION);
  const corrected = `${DESCRIPTION}\nОтчёт передать руководителю южного филиала.`;
  await form.getByLabel("Подробности", { exact: true }).fill(corrected);
  await expect(form.getByRole("checkbox", { name: "Я проверил поручение по исходной записи" })).not.toBeChecked();
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(patches).toEqual([{ description: corrected }]);
  await expect(page.locator(".tasks-description")).toHaveText(corrected);
  await expect(page.locator(".tasks-deadline-original")).toHaveText("«на следующей неделе»");
  await expect(page.locator(".tasks-reviewed")).toHaveCount(0);
});

for (const status of ["processing", "failed"] as const) {
  test(`saved ${status} task evidence is readable but task edits and reviewed claims are unavailable`, async ({ page }) => {
    const meeting = fixture();
    meeting.status = status;
    meeting.stage = "extract";
    meeting.progress = 80;
    meeting.error = status === "failed" ? { code: "COVERAGE_CHECK_FAILED", message: "Проверка полноты не завершена" } : null;
    const mutations = await openMeeting(page, meeting);
    await expect(page.locator(".tasks-description")).toHaveText(DESCRIPTION);
    await expect(page.getByRole("button", { name: /Редактировать поручение:/ })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Я проверил поручение по исходной записи" })).toHaveCount(0);
    await expect(page.locator(".tasks-reviewed")).toHaveCount(0);
    await page.getByRole("button", { name: `Показать источник поручения: ${TASK_TITLE}` }).click();
    await expect(page.getByRole("region", { name: `Источник поручения: ${TASK_TITLE}` }).locator("blockquote")).toBeVisible();
    expect(mutations).toEqual([]);
  });
}
