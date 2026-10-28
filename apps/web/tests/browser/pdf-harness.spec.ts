import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const enabled = process.env.ADOBO_ENGINE_CHECK !== "0";
const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);
const corrupt = new URL("../fixtures/pdf/corrupt.pdf", import.meta.url);
const protectedPdf = new URL("../fixtures/pdf/protected-two-page.pdf", import.meta.url);

async function isolated(browserName: string, run: (page: Page) => Promise<void>) {
  const type = { chromium, firefox, webkit }[browserName as "chromium" | "firefox" | "webkit"];
  if (!type) throw new Error("Unknown browser engine");
  // E02b L09: full matching installed Chromium avoids the macOS headless-shell crash.
  const browser = await type.launch(browserName === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try {
      const requests: { url: string; method: string }[] = [];
      context.on("request", (r) => requests.push({ url: r.url(), method: r.method() }));
      const page = await context.newPage();
      await run(page);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(new URL(request.url).origin).toBe("http://127.0.0.1:3100");
        expect(["GET", "HEAD"]).toContain(request.method);
        expect(new URL(request.url).pathname).not.toMatch(/\.pdf$/);
      }
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

test.describe("private local PDF worker canvas harness", () => {
  test.skip(!enabled, "engineering route is disabled");

  test("local file -> count -> red canvas; cancel, error, replacement, close and no uploads", async ({ browserName }) => {
    await isolated(browserName, async (page) => {
      const bytes = await readFile(valid);
      expect(bytes.byteLength).toBeGreaterThan(0);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const response = await page.goto("./engine-check", { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      const file = page.getByTestId("harness-file");
      const state = page.getByTestId("harness-state");
      const canvas = page.getByTestId("harness-canvas");
      await expect(file).toBeVisible();
      await expect(state).toContainText("idle:");

      await file.setInputFiles(valid.pathname);
      await expect(state).toContainText("ready:", { timeout: 30_000 });
      await expect(page.getByTestId("harness-pages")).toHaveText("Pages: 2");
      await expect(canvas).toBeVisible();
      const first = await canvas.evaluate((element) => {
        const c = element as HTMLCanvasElement;
        const color = c.getContext("2d")!.getImageData(40, 40, 1, 1).data;
        return { size: [c.width, c.height], pixel: Array.from(color) };
      });
      expect(first.size).toEqual([200, 300]);
      expect(first.pixel).toEqual([255, 0, 0, 255]);

      // A cancelled native picker does not emit input change. Exercise cancel alone.
      await file.dispatchEvent("cancel");
      await expect(state).toContainText("ready:");
      await expect(page.getByTestId("harness-pages")).toHaveText("Pages: 2");

      // Re-selecting the same file replaces the active document cleanly.
      await file.setInputFiles(valid.pathname);
      await expect(state).toContainText("ready:", { timeout: 30_000 });
      await expect(page.getByTestId("harness-pages")).toHaveText("Pages: 2");

      await file.setInputFiles(corrupt.pathname);
      await expect(state).toContainText("error:", { timeout: 30_000 });
      await expect(state).toContainText("could not be opened");
      await expect(canvas).toBeHidden();
      await expect(page.getByTestId("harness-pages")).toHaveCount(0);
      const afterCorrupt = await page.evaluate(() => window.__adoboEngineCheck!.worker.stats());
      expect(afterCorrupt).toEqual({ activeDocuments: 0, activeAllocations: 0 });

      await file.setInputFiles(protectedPdf.pathname);
      await expect(state).toContainText("error:", { timeout: 30_000 });
      await expect(state).toContainText("password");
      await file.setInputFiles(valid.pathname);
      await expect(state).toContainText("ready:", { timeout: 30_000 });

      await page.getByRole("button", { name: "Close document" }).click();
      await expect(state).toContainText("idle: Document closed.");
      await expect(canvas).toBeHidden();
      const afterClose = await page.evaluate(async () => ({
        stats: await window.__adoboEngineCheck!.worker.stats(),
        size: (() => {
          const c = document.querySelector('[data-testid="harness-canvas"]') as HTMLCanvasElement;
          return [c.width, c.height];
        })(),
      }));
      expect(afterClose).toEqual({
        stats: { activeDocuments: 0, activeAllocations: 0 },
        size: [0, 0],
      });
      expect(errors).toEqual([]);
    });
  });
});
