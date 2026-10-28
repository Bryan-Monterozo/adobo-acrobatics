import { defineConfig } from "@playwright/test";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
if (!/^(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) {
  throw new Error("Invalid NEXT_PUBLIC_BASE_PATH for browser tests.");
}

const engineCheck = process.env.ADOBO_ENGINE_CHECK === "1";
const origin = "http://127.0.0.1:3100";
const baseURL = `${origin}${basePath}/`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: "list",
  use: {
    baseURL,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: `npm run build && npm run ${engineCheck ? "start:test" : "start"}`,
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      ADOBO_ENGINE_CHECK: engineCheck ? "1" : "0",
      NEXT_PUBLIC_BASE_PATH: basePath,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
