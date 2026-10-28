import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";
import { visitEngine } from "./engine-driver";

const enabled = process.env.ADOBO_ENGINE_CHECK !== "0";
const validFixture = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);

async function isolated(name: string, check: (page: Page) => Promise<void>) {
  const browserType = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!browserType) throw new Error("Unknown Playwright project");
  // Existing E02b workaround: use Playwright-installed full Chromium per scenario.
  const browser = await browserType.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try { await check(await context.newPage()); }
    finally { await context.close(); }
  } finally { await browser.close(); }
}

test.describe("real PDFium owned RGBA rendering", () => {
  test.skip(!enabled, "requires private engineering mode");

  test("renders both pages at DPR 1/2, preserves owned pixels after close and rejects invalid indices", async ({ browserName }) => {
    const bytes = Array.from(await readFile(validFixture));
    await isolated(browserName, async (page) => {
      await visitEngine(page);
      const result = await page.evaluate(async (fixtureBytes) => {
        const driver = window.__adoboEngineCheck;
        if (!driver) throw new Error("Missing engineering driver");
        const opened = await driver.open(Uint8Array.from(fixtureBytes));
        const opt = (dpr: number) => ({ scale: 1 as const, rotation: 0 as const, dpr });
        const sample = (rgba: ArrayBuffer, width: number, x: number, y: number) =>
          Array.from(new Uint8Array(rgba, (y * width + x) * 4, 4));
        const results: Array<{
          page: number; dpr: number; width: number; height: number;
          displayWidth: number; displayHeight: number;
          marker: number[]; white: number[]; length: number;
        }> = [];
        const ownedCopies: Array<{ rgba: ArrayBuffer; width: number; dpr: number; page: number }> = [];

        for (const dpr of [1, 2]) {
          for (const index of [0, 1]) {
            const pixels = await driver.render(opened.sessionId, index, opt(dpr));
            const marker = sample(pixels.rgba, pixels.width, 40 * dpr, 40 * dpr);
            const white = sample(pixels.rgba, pixels.width, 4 * dpr, 4 * dpr);
            results.push({
              page: index, dpr,
              width: pixels.width, height: pixels.height,
              displayWidth: pixels.displayWidth, displayHeight: pixels.displayHeight,
              marker, white,
              length: pixels.rgba.byteLength,
            });
            ownedCopies.push({ rgba: pixels.rgba, width: pixels.width, dpr, page: index });
          }
        }
        const errors: string[] = [];
        for (const index of [-1, 2, 1.5]) {
          try { await driver.render(opened.sessionId, index, opt(1)); }
          catch (error) { errors.push((error as { kind: string }).kind); }
        }
        for (const options of [
          { scale: 2, rotation: 0, dpr: 1 },
          { scale: 1, rotation: 90, dpr: 1 },
          { scale: 1, rotation: 0, dpr: 3 },
        ]) {
          try { await driver.render(opened.sessionId, 0, options as Parameters<typeof driver.render>[2]); }
          catch (error) { errors.push((error as { kind: string }).kind); }
        }
        driver.close(opened.sessionId);
        let closed = "";
        try { await driver.render(opened.sessionId, 0, opt(1)); }
        catch (error) { closed = (error as { kind: string }).kind; }
        const survived = ownedCopies.map((copy) =>
          sample(copy.rgba, copy.width, 40 * copy.dpr, 40 * copy.dpr));
        const after = driver.stats();
        return { results, errors, closed, survived, after, pageCount: opened.pageCount };
      }, bytes);

      expect(result.pageCount).toBe(2);
      expect(result.results).toHaveLength(4);
      for (const entry of result.results) {
        expect([entry.width, entry.height]).toEqual([200 * entry.dpr, 300 * entry.dpr]);
        expect([entry.displayWidth, entry.displayHeight]).toEqual([200, 300]);
        expect(entry.length).toBe(entry.width * entry.height * 4);
        expect(entry.marker).toEqual(entry.page === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
        expect(entry.white).toEqual([255, 255, 255, 255]);
      }
      expect(result.errors).toEqual([
        "INVALID_PAGE", "INVALID_PAGE", "INVALID_PAGE",
        "INVALID_RENDER_OPTIONS", "INVALID_RENDER_OPTIONS", "INVALID_RENDER_OPTIONS",
      ]);
      expect(result.closed).toBe("SESSION_CLOSED");
      expect(result.survived).toEqual([
        [255, 0, 0, 255], [0, 0, 255, 255],
        [255, 0, 0, 255], [0, 0, 255, 255],
      ]);
      expect(result.after).toMatchObject({ activeDocuments: 0, activeAllocations: 0 });
    });
  });
});
