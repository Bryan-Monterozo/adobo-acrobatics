import { expect, type Page } from "@playwright/test";

export type ReadinessResult = {
  ok: boolean;
  kind?: string;
  message?: string;
  stats: {
    attempts: number;
    successes: number;
    failures: number;
    nativeCalls: number;
    ready: boolean;
  };
};

export async function visitEngine(page: Page) {
  const response = await page.goto("./engine-check", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await page.waitForFunction(() =>
    Boolean((window as Window & { __adoboEngineCheck?: unknown }).__adoboEngineCheck),
  );
}

export async function runReadiness(page: Page): Promise<ReadinessResult> {
  return page.evaluate(async () => {
    const driver = (window as Window & {
      __adoboEngineCheck?: {
        ready(): Promise<void>;
        stats(): ReadinessResult["stats"];
      };
    }).__adoboEngineCheck;
    if (!driver) throw new Error("Engineering driver is not registered");
    try {
      await driver.ready();
      return { ok: true, stats: driver.stats() };
    } catch (error) {
      const normalized = error as { kind?: string; message?: string };
      return {
        ok: false,
        kind: normalized.kind,
        message: normalized.message,
        stats: driver.stats(),
      };
    }
  });
}
