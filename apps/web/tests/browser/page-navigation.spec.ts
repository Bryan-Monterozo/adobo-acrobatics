import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";

const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);

async function inBrowser(name: string, check: (page: Page) => Promise<void>) {
  const type = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!type) throw Error("Unknown browser");
  // Use the matching Playwright-installed full Chromium (L09).
  const browser = await type.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try { await check(await context.newPage()); }
    finally { await context.close(); }
  } finally { await browser.close(); }
}

async function marker(page: Page) {
  return page.getByTestId("viewer-canvas").evaluate(el => {
    const c = el as HTMLCanvasElement;
    return Array.from(c.getContext("2d")!.getImageData(40, 40, 1, 1).data);
  });
}

test.describe("P03.02 public page navigation", () => {
  test("previous/next and direct entry render 1→2→1 with endpoint controls", async ({ browserName }) => {
    await inBrowser(browserName, async page => {
      expect((await page.goto("./"))?.status()).toBe(200);
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      const count = page.getByTestId("viewer-page-count");
      const prev = page.getByTestId("page-previous");
      const next = page.getByTestId("page-next");
      await expect(count).toHaveText("Page 1 of 2", { timeout: 30_000 });
      await expect(prev).toBeDisabled();
      await expect(next).toBeEnabled();
      expect(await marker(page)).toEqual([255, 0, 0, 255]);

      await next.click();
      await expect(count).toHaveText("Page 2 of 2");
      expect(await marker(page)).toEqual([0, 0, 255, 255]);
      await expect(prev).toBeEnabled();
      await expect(next).toBeDisabled();

      await prev.click();
      await expect(count).toHaveText("Page 1 of 2");
      expect(await marker(page)).toEqual([255, 0, 0, 255]);

      await page.getByTestId("page-entry").fill("2");
      await page.getByTestId("page-go").click();
      await expect(count).toHaveText("Page 2 of 2");
      expect(await marker(page)).toEqual([0, 0, 255, 255]);
      await page.getByTestId("page-entry").fill("1");
      await page.getByTestId("page-go").click();
      await expect(count).toHaveText("Page 1 of 2");
      expect(await marker(page)).toEqual([255, 0, 0, 255]);
    });
  });

  test("invalid numeric entry never sends a native render or changes the shown page", async ({ browserName }) => {
    await inBrowser(browserName, async page => {
      expect((await page.goto("./"))?.status()).toBe(200);
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");
      await page.evaluate(() => {
        const state = window as Window & { __renderRequests?: number };
        state.__renderRequests = 0;
        const post = Worker.prototype.postMessage as (this: Worker, message: unknown, transfer: Transferable[]) => void;
        Worker.prototype.postMessage = function(this: Worker, message: unknown, transfer?: Transferable[]) {
          if (typeof message === "object" && message !== null &&
            (message as { operation?: string }).operation === "RENDER") {
            state.__renderRequests = (state.__renderRequests ?? 0) + 1;
          }
          return post.call(this, message, transfer ?? []);
        } as typeof Worker.prototype.postMessage;
      });

      for (const raw of ["0", "3", "1.5", "abc", "1e0", "-1", "", " 2"]) {
        await page.getByTestId("page-entry").fill(raw);
        await page.getByTestId("page-go").click();
        await expect(page.locator("#page-entry-error")).toContainText("whole page number");
        await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");
        expect(await marker(page)).toEqual([255, 0, 0, 255]);
      }
      expect(await page.evaluate(() =>
        (window as Window & { __renderRequests?: number }).__renderRequests)).toBe(0);

      await page.getByTestId("page-entry").fill("2");
      await page.getByTestId("page-go").click();
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 2 of 2");
      expect(await marker(page)).toEqual([0, 0, 255, 255]);
      expect(await page.evaluate(() =>
        (window as Window & { __renderRequests?: number }).__renderRequests)).toBe(1);
    });
  });
  test("a delayed obsolete page-2 render never paints over a later page-1 request", async ({ browserName }) => {
    await inBrowser(browserName, async page => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      expect((await page.goto("./"))?.status()).toBe(200);
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");

      await page.evaluate(() => {
        const win = window as Window & { __releasePage2?: () => void };
        const post = Worker.prototype.postMessage as (this: Worker, message: unknown, transfer: Transferable[]) => void;
        let delayed = false;
        Worker.prototype.postMessage = function(this: Worker, message: unknown, transfer?: Transferable[]) {
          const request = message as { operation?: string; pageIndex?: number };
          if (!delayed && request?.operation === "RENDER" && request.pageIndex === 1) {
            delayed = true;
            const target = this;
            win.__releasePage2 = () => { post.call(target, message, transfer ?? []); };
            return;
          }
          return post.call(this, message, transfer ?? []);
        } as typeof Worker.prototype.postMessage;
      });

      await page.getByTestId("page-next").click();
      await expect(page.getByTestId("viewer-state")).toContainText("Rendering page 2");
      await expect(page.getByTestId("viewer-canvas")).toBeHidden();
      await expect(page.getByTestId("viewer-page-count")).toHaveCount(0);
      await expect(page.getByTestId("page-previous")).toBeEnabled();

      await page.getByTestId("page-previous").click();
      await expect(page.getByTestId("viewer-state")).toContainText("Rendering page 1");
      await page.evaluate(() => {
        const release = (window as Window & { __releasePage2?: () => void }).__releasePage2;
        if (!release) throw Error("No intercepted render");
        release();
      });
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");
      expect(await marker(page)).toEqual([255, 0, 0, 255]);
      await expect(page.getByTestId("page-next")).toBeEnabled();
      await expect(page.getByTestId("page-previous")).toBeDisabled();
      expect(errors).toEqual([]);
    });
  });

});
