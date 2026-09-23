import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({
  executablePath: chromium.executablePath(),
});
const page = await browser.newPage({
  viewport: { width: 1536, height: 1050 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("http://127.0.0.1:5173/");
await page
  .getByRole("heading", { name: "Пилот городского сервиса · рабочая встреча" })
  .waitFor();
await page.evaluate(() => document.fonts.ready);
await mkdir("test-results", { recursive: true });
await page.screenshot({
  path: "test-results/demo-desktop.png",
  fullPage: true,
  animations: "disabled",
});
await page.screenshot({
  path: "test-results/demo-desktop-viewport.png",
  animations: "disabled",
});
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
  path: "test-results/demo-mobile.png",
  fullPage: true,
  animations: "disabled",
});
await page.screenshot({
  path: "test-results/demo-mobile-viewport.png",
  animations: "disabled",
});
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > window.innerWidth,
);
await page.getByRole("button", { name: "Открыть меню" }).click();
await page.getByRole("button", { name: "Новое совещание" }).click();
await page.screenshot({
  path: "test-results/demo-upload-mobile.png",
  fullPage: true,
});
console.log(JSON.stringify({ errors, mobileOverflow: overflow }));
await browser.close();
