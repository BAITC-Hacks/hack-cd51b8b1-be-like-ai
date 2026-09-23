import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

// A fresh, test-only code shared with the isolated server and test workers.
// Never read HACKALEM_ACCESS_TOKEN or include this value in the frontend build.
process.env.MEETORA_INTEGRATION_TOKEN ??= randomBytes(24).toString("hex");

const backendURL = "http://127.0.0.1:8189";
const proxyURL = "http://127.0.0.1:4189";

export default defineConfig({
  testDir: "./integration",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: "./test-results/integration",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "fastapi-production", use: { baseURL: backendURL } },
    { name: "vite-proxy", use: { baseURL: proxyURL } },
  ],
  webServer: [
    {
      command: "node integration/serve-backend.mjs",
      url: `${backendURL}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        MEETORA_INTEGRATION_TOKEN: process.env.MEETORA_INTEGRATION_TOKEN,
      },
    },
    {
      command: "npm run dev -- --port 4189 --strictPort",
      url: proxyURL,
      reuseExistingServer: false,
      env: {
        VITE_USE_MOCKS: "false",
        VITE_API_BASE_URL: "/api",
        VITE_PROXY_TARGET: backendURL,
      },
    },
  ],
});
