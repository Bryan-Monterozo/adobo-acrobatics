import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";
import { runReadiness, visitEngine } from "./engine-driver";

const enabled = process.env.ADOBO_ENGINE_CHECK !== "0";
const asset = "**/pdfium/2.15.1/pdfium.wasm";

// Native PDFium + repeated fresh contexts crashes the macOS Chromium headless
// shell. Use isolated Playwright-installed browser processes for each scenario;
// Chromium's full matching binary is selected, not a system browser.
async function isolated(name: string, check: (page: Page) => Promise<void>) {
  const type = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!type) throw new Error("Unknown browser project");
  const browser = await type.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try { await check(await context.newPage()); }
    finally { await context.close(); }
  } finally { await browser.close(); }
}

test.describe("real PDFium readiness", () => {
  test.skip(!enabled, "engineering mode disabled");

  test("loads native WASM once, runs extension and native export", async ({ browserName }) => {
    await isolated(browserName, async (page) => {
      const requests: string[] = [];
      page.on("request", (r) => {
        if (r.url().endsWith("/pdfium/2.15.1/pdfium.wasm")) requests.push(r.url());
      });
      await visitEngine(page);
      expect(await runReadiness(page)).toMatchObject({
        ok: true, stats: { attempts: 1, successes: 1, failures: 0, nativeCalls: 1, ready: true },
      });
      expect(await runReadiness(page)).toMatchObject({
        ok: true, stats: { attempts: 2, successes: 2, failures: 0, nativeCalls: 2, ready: true },
      });
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]).origin).toBe("http://127.0.0.1:3100");
      await page.goto("./");
      expect(await page.evaluate(() => "__adoboEngineCheck" in window)).toBe(false);
    });
  });

  for (const failure of ["missing", "corrupt"] as const) {
    test(failure + " WASM first fails then native startup recovers", async ({ browserName }) => {
      await isolated(browserName, async (page) => {
        let hits = 0;
        await page.route(asset, async (route) => {
          hits++;
          if (hits > 1) return route.continue();
          if (failure === "missing") return route.fulfill({ status: 404, body: "missing" });
          return route.fulfill({ status: 200, contentType: "application/wasm", body: "not a wasm" });
        });
        await visitEngine(page);
        expect(await runReadiness(page)).toMatchObject({
          ok: false, kind: "RUNTIME_LOAD",
          stats: { attempts: 1, successes: 0, failures: 1, nativeCalls: 0, ready: false },
        });
        expect(await runReadiness(page)).toMatchObject({
          ok: true, stats: { attempts: 2, successes: 1, failures: 1, nativeCalls: 1, ready: true },
        });
        expect(hits).toBe(2);
      });
    });
  }
});

test.describe("production gate disabled", () => {
  test.skip(enabled, "requires engineering mode off");
  test("denies engineering route, query bypass and native traffic", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/pdfium/2.15.1/pdfium.wasm")) requests.push(r.url());
    });
    expect((await page.goto("./engine-check"))?.status()).toBe(404);
    expect(await page.evaluate(() => "__adoboEngineCheck" in window)).toBe(false);
    expect((await page.goto("./engine-check?ADOBO_ENGINE_CHECK=1"))?.status()).toBe(404);
    expect(await page.evaluate(() => "__adoboEngineCheck" in window)).toBe(false);
    expect((await page.goto("./"))?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Adobo Acrobatics" })).toBeVisible();
    expect(await page.evaluate(() => "__adoboEngineCheck" in window)).toBe(false);
    expect(requests).toEqual([]);
  });
});
