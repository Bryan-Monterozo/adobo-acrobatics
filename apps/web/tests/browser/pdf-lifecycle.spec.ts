import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";

const enabled = process.env.ADOBO_ENGINE_CHECK !== "0";
const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);
const corrupt = new URL("../fixtures/pdf/corrupt.pdf", import.meta.url);

async function inOwnedBrowser(name: string, run: (page: Page) => Promise<void>) {
  const type = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!type) throw new Error("Unexpected browser project");
  // E02b/L09: matching Playwright-installed full Chromium avoids the unstable
  // macOS headless-shell process; no system browser/global install is used.
  const browser = await type.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try { await run(await context.newPage()); }
    finally { await context.close(); }
  } finally { await browser.close(); }
}

test.describe("E09 real PDFium worker lifecycle", () => {
  test.skip(!enabled, "private engineering route is disabled");

  test("20 real open/render/close cycles with invalid input and a valid retry", async ({ browserName }) => {
    const bytes = Array.from(await readFile(valid));
    const malformed = Array.from(await readFile(corrupt));
    await inOwnedBrowser(browserName, async (page) => {
      const pageErrors: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      expect((await page.goto("./engine-check", { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
      await page.waitForFunction(() => Boolean(window.__adoboEngineCheck?.worker));

      const result = await page.evaluate(async ({ bytes, malformed }) => {
        const client = window.__adoboEngineCheck!.worker;
        await client.ready();
        const original = Uint8Array.from(bytes);
        const originalCopy = original.slice();
        const samples: Array<{ cycle: number; page: number; pixel: number[];
          backing: number[]; after: { activeDocuments: number; activeAllocations: number } }> = [];
        let failedKind = "";
        let failedOwnership: { activeDocuments: number; activeAllocations: number } | null = null;
        for (let cycle = 0; cycle < 20; cycle++) {
          // A failed native open between successful cycles must never poison the
          // single worker or retain a document allocation.
          if (cycle === 10) {
            try { await client.open(Uint8Array.from(malformed)); }
            catch (e) { failedKind = (e as { kind: string }).kind; }
            failedOwnership = await client.stats();
          }
          const document = await client.open(original);
          if (document.pageCount !== 2) throw Error("Unexpected page count");
          const pageIndex = cycle % 2;
          const image = await client.render(document.sessionId, pageIndex,
            { scale: 1, rotation: 0, dpr: 1 });
          const view = new Uint8Array(image.rgba);
          const at = (40 * image.width + 40) * 4;
          const pixel = Array.from(view.subarray(at, at + 4));
          const backing = [image.width, image.height, image.rgba.byteLength];
          await client.close(document.sessionId);
          const after = await client.stats();
          samples.push({ cycle, page: pageIndex, pixel, backing, after });
        }
        const inputIntact = original.every((v, i) => v === originalCopy[i]);
        const final = await client.stats();
        await client.dispose();
        let disposedKind = "";
        try { await client.ready(); }
        catch (e) { disposedKind = (e as { kind: string }).kind; }
        return { samples, failedKind, failedOwnership, inputIntact, final, disposedKind };
      }, { bytes, malformed });

      expect(result.samples).toHaveLength(20);
      for (const row of result.samples) {
        expect(row.backing).toEqual([200, 300, 240_000]);
        expect(row.pixel).toEqual(
          row.page === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255],
        );
        expect(row.after).toEqual({ activeDocuments: 0, activeAllocations: 0 });
      }
      expect(result.failedKind).toBe("INVALID_DOCUMENT");
      expect(result.failedOwnership).toEqual({ activeDocuments: 0, activeAllocations: 0 });
      expect(result.final).toEqual({ activeDocuments: 0, activeAllocations: 0 });
      expect(result.inputIntact).toBe(true);
      expect(result.disposedKind).toBe("WORKER_FAILED");
      expect(pageErrors).toEqual([]);
    });
  });

  test("the file-picker error state recovers to a valid canvas and closes cleanly", async ({ browserName }) => {
    await inOwnedBrowser(browserName, async page => {
      expect((await page.goto("./engine-check"))?.status()).toBe(200);
      const picker = page.getByTestId("harness-file");
      const state = page.getByTestId("harness-state");
      await picker.setInputFiles(corrupt.pathname);
      await expect(state).toContainText("error:", { timeout: 30_000 });
      await expect(page.getByTestId("harness-canvas")).toBeHidden();
      await picker.setInputFiles(valid.pathname);
      await expect(state).toContainText("ready:", { timeout: 30_000 });
      await expect(page.getByTestId("harness-pages")).toHaveText("Pages: 2");
      const pixel = await page.getByTestId("harness-canvas").evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return Array.from(canvas.getContext("2d")!.getImageData(40, 40, 1, 1).data);
      });
      expect(pixel).toEqual([255, 0, 0, 255]);
      await page.getByRole("button", { name: "Close document" }).click();
      await expect(state).toContainText("idle: Document closed.");
      expect(await page.evaluate(() => window.__adoboEngineCheck!.worker.stats()))
        .toEqual({ activeDocuments: 0, activeAllocations: 0 });
    });
  });
});
