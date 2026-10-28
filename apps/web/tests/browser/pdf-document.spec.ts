import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";
import { visitEngine } from "./engine-driver";

const enabled = process.env.ADOBO_ENGINE_CHECK !== "0";
const fixtureUrl = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);

async function isolated(name: string, check: (page: Page) => Promise<void>) {
  const browserType = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!browserType) throw new Error("Unknown browser engine");
  // Same isolation as E02b: use the matching full installed Chromium binary.
  const browser = await browserType.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try { await check(await context.newPage()); }
    finally { await context.close(); }
  } finally { await browser.close(); }
}

test.describe("real PDFium document ownership", () => {
  test.skip(!enabled, "engineering mode disabled");

  test("two-page fixture opens, native ownership closes, and a fresh session works", async ({ browserName }) => {
    const bytes = Array.from(await readFile(fixtureUrl));
    await isolated(browserName, async (page) => {
      await visitEngine(page);
      const result = await page.evaluate(async (fixtureBytes) => {
        const driver = window.__adoboEngineCheck;
        if (!driver) throw new Error("Missing engineering driver");
        const source = Uint8Array.from(fixtureBytes);
        const unchanged = source.slice();
        const opened = await driver.open(source);
        const active = driver.stats();
        let activeError = "";
        try { await driver.open(source); }
        catch (error) { activeError = (error as { kind: string }).kind; }
        driver.close(opened.sessionId);
        driver.close(opened.sessionId);
        const afterClose = driver.stats();
        const reopened = await driver.open(source);
        const secondActive = driver.stats();
        driver.close(reopened.sessionId);
        const final = driver.stats();
        return {
          firstCount: opened.pageCount,
          opaqueSession: /^[0-9a-f-]{36}$/.test(opened.sessionId),
          anotherSession: opened.sessionId !== reopened.sessionId,
          secondCount: reopened.pageCount,
          untouchedInput: source.every((value, index) => value === unchanged[index]),
          activeError, active, afterClose, secondActive, final,
        };
      }, bytes);
      expect(result).toMatchObject({
        firstCount: 2, secondCount: 2, opaqueSession: true, anotherSession: true,
        untouchedInput: true, activeError: "SESSION_ACTIVE",
        active: { activeDocuments: 1, activeAllocations: 1 },
        afterClose: { activeDocuments: 0, activeAllocations: 0 },
        secondActive: { activeDocuments: 1, activeAllocations: 1 },
        final: { activeDocuments: 0, activeAllocations: 0 },
      });
      expect(await page.evaluate(() => "__adoboEngineCheck" in window)).toBe(true);
      await page.goto("./");
      expect(await page.evaluate(() => "__adoboEngineCheck" in window)).toBe(false);
    });
  });

  test("empty and oversized inputs reject before native allocation", async ({ browserName }) => {
    await isolated(browserName, async (page) => {
      await visitEngine(page);
      const result = await page.evaluate(async () => {
        const driver = window.__adoboEngineCheck;
        if (!driver) throw new Error("Missing engineering driver");
        const errors: string[] = [];
        for (const input of [new Uint8Array(), new Uint8Array(26_214_401)]) {
          try { await driver.open(input); }
          catch (error) { errors.push((error as { kind: string }).kind); }
        }
        return { errors, stats: driver.stats() };
      });
      expect(result).toMatchObject({
        errors: ["INVALID_DOCUMENT", "LIMIT_EXCEEDED"],
        stats: { activeDocuments: 0, activeAllocations: 0 },
      });
    });
  });
});
