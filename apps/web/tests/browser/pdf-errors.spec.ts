import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";
import { visitEngine } from "./engine-driver";

const enabled = process.env.ADOBO_ENGINE_CHECK !== "0";
const fixtures = {
  valid: new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url),
  protected: new URL("../fixtures/pdf/protected-two-page.pdf", import.meta.url),
  corrupt: new URL("../fixtures/pdf/corrupt.pdf", import.meta.url),
  empty: new URL("../fixtures/pdf/empty.pdf", import.meta.url),
};

async function isolated(name: string, action: (page: Page) => Promise<void>) {
  const type = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!type) throw new Error("Unrecognized browser engine");
  // E02b L09: Playwright's installed full Chromium avoids the crashing headless shell.
  const browser = await type.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try { await action(await context.newPage()); }
    finally { await context.close(); }
  } finally { await browser.close(); }
}

test.describe("real PDFium document errors and recovery", () => {
  test.skip(!enabled, "requires private engineering mode");

  test("rejects empty, corrupt, protected and oversized input, then opens a valid PDF after each", async ({ browserName }) => {
    const bytes = {
      valid: Array.from(await readFile(fixtures.valid)),
      protected: Array.from(await readFile(fixtures.protected)),
      corrupt: Array.from(await readFile(fixtures.corrupt)),
      empty: Array.from(await readFile(fixtures.empty)),
    };

    await isolated(browserName, async (page) => {
      const results = await (async () => {
        await visitEngine(page);
        return page.evaluate(async (inputs) => {
          const driver = window.__adoboEngineCheck;
          if (!driver) throw new Error("Engineering driver was not registered");
          const cases = [
            { key: "empty", payload: Uint8Array.from(inputs.empty), kind: "INVALID_DOCUMENT" },
            { key: "corrupt", payload: Uint8Array.from(inputs.corrupt), kind: "INVALID_DOCUMENT" },
            { key: "protected", payload: Uint8Array.from(inputs.protected), kind: "PASSWORD_REQUIRED_OR_INVALID" },
            { key: "oversized", payload: new Uint8Array(26_214_401), kind: "LIMIT_EXCEEDED" },
          ];
          const results = [];
          for (const item of cases) {
            let result: { kind?: string; nativeCode?: number; message?: string } = {};
            try { await driver.open(item.payload); }
            catch (e) {
              const error = e as { kind?: string; nativeCode?: number; message?: string };
              result = { kind: error.kind, nativeCode: error.nativeCode, message: error.message };
            }
            const afterFailure = driver.stats();
            const open = await driver.open(Uint8Array.from(inputs.valid));
            const duringSuccess = driver.stats();
            driver.close(open.sessionId);
            driver.close(open.sessionId);
            const afterRecovery = driver.stats();
            results.push({
              fixture: item.key, expected: item.kind, result,
              afterFailure: {
                activeDocuments: afterFailure.activeDocuments,
                activeAllocations: afterFailure.activeAllocations,
              },
              pageCount: open.pageCount,
              duringSuccess: {
                activeDocuments: duringSuccess.activeDocuments,
                activeAllocations: duringSuccess.activeAllocations,
              },
              afterRecovery: {
                activeDocuments: afterRecovery.activeDocuments,
                activeAllocations: afterRecovery.activeAllocations,
              },
            });
          }
          return results;
        }, bytes);
      })();

      expect(results).toHaveLength(4);
      for (const item of results) {
        expect(item.result.kind).toBe(item.expected);
        expect(item.result.message).toBeTruthy();
        expect(item.result.message).not.toContain("valid-two-page.pdf");
        expect(item.afterFailure).toEqual({ activeDocuments: 0, activeAllocations: 0 });
        expect(item.pageCount).toBe(2);
        expect(item.duringSuccess).toEqual({ activeDocuments: 1, activeAllocations: 1 });
        expect(item.afterRecovery).toEqual({ activeDocuments: 0, activeAllocations: 0 });
      }
      const protectedResult = results.find((item) => item.fixture === "protected");
      expect(protectedResult?.result.nativeCode).toBe(4);
      await page.goto("./");
      expect(await page.evaluate(() => "__adoboEngineCheck" in window)).toBe(false);
    });
  });
});
