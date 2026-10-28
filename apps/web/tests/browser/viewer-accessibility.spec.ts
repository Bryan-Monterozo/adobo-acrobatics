import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";

const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);
const corrupt = new URL("../fixtures/pdf/corrupt.pdf", import.meta.url);
const protectedPdf = new URL("../fixtures/pdf/protected-two-page.pdf", import.meta.url);

async function withBrowser(name: string, fn: (page: Page) => Promise<void>) {
  const type = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!type) throw Error("Unrecognized browser");
  // L09: matching Playwright-installed full Chromium avoids macOS headless-shell instability.
  const browser = await type.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", err => errors.push(err.message));
      await fn(page);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

async function assertVisibleKeyboardFocus(page: Page) {
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return { visible: false, style: "none", width: 0 };
    const css = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { visible: css.outlineStyle !== "none", style: css.outlineStyle,
      width: parseFloat(css.outlineWidth), elementWidth: rect.width };
  });
  expect(focus.visible).toBe(true);
  expect(focus.width).toBeGreaterThanOrEqual(3);
  expect(focus.elementWidth).toBeGreaterThan(0);
}

async function marker(page: Page): Promise<number[]> {
  return await page.getByTestId("viewer-canvas").evaluate(el => {
    const c = el as HTMLCanvasElement;
    return Array.from(c.getContext("2d")!.getImageData(40, 40, 1, 1).data);
  });
}

test.describe("P05.02 accessible public viewer controls", () => {
  test("keyboard alone activates file chooser, navigates pages, reports invalid entry and closes", async ({ browserName }) => {
    await withBrowser(browserName, async page => {
      expect((await page.goto("./"))?.status()).toBe(200);
      const file = page.getByTestId("viewer-file");
      const close = page.getByTestId("viewer-close");
      const status = page.getByTestId("viewer-state");
      await expect(file).toHaveAccessibleName("Choose a PDF from your device");
      await expect(close).toHaveAccessibleName("Close document");
      await expect(file).toHaveAttribute("aria-describedby", "pdf-local-notice");
      await expect(status).toHaveAttribute("role", "status");
      await expect(status).toHaveAttribute("aria-atomic", "true");

      await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
      await expect(file).toBeFocused();
      await assertVisibleKeyboardFocus(page);
      const chooser = page.waitForEvent("filechooser");
      await page.keyboard.press("Enter");
      await (await chooser).setFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
      expect(await marker(page)).toEqual([255, 0, 0, 255]);
      await expect(page.getByTestId("viewer-canvas"))
        .toHaveAccessibleName("Visual preview of page 1 of 2; PDF text is not available in this image");
      await expect(page.getByRole("navigation", { name: "PDF page navigation" })).toBeVisible();
      await expect(page.getByTestId("page-previous")).toBeDisabled();
      await expect(page.getByTestId("page-next")).toBeEnabled();

      // The natural Tab sequence skips disabled Previous.
      await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
      await expect(close).toBeFocused();
      await assertVisibleKeyboardFocus(page);
      await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
      const entry = page.getByTestId("page-entry");
      await expect(entry).toBeFocused();
      await expect(entry).toHaveAccessibleName("Page");
      await expect(entry).toHaveAttribute("aria-describedby", "page-count-total");
      await assertVisibleKeyboardFocus(page);

      await page.keyboard.type("0");
      await page.keyboard.press("Enter");
      await expect(page.locator("#page-entry-error")).toHaveText("Enter a whole page number from 1 to 2.");
      await expect(entry).toHaveAttribute("aria-invalid", "true");
      await expect(entry).toHaveAttribute("aria-describedby", "page-count-total page-entry-error");
      await expect(entry).toBeFocused();
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");

      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("2");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 2 of 2");
      await expect(page.getByTestId("viewer-state")).toContainText("Page 2 of 2 ready.");
      expect(await marker(page)).toEqual([0, 0, 255, 255]);
      await expect(page.getByTestId("viewer-canvas"))
        .toHaveAccessibleName("Visual preview of page 2 of 2; PDF text is not available in this image");
      await expect(page.getByTestId("page-next")).toBeDisabled();
      await expect(page.getByTestId("page-previous")).toBeEnabled();

      await page.getByTestId("page-previous").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");
      expect(await marker(page)).toEqual([255, 0, 0, 255]);

      await close.focus();
      await page.keyboard.press("Enter");
      await expect(status).toContainText("Choose a PDF");
      await expect(status).toHaveAttribute("role", "status");
      await expect(page.getByTestId("viewer-page-count")).toHaveCount(0);
      await expect(page.getByTestId("page-entry")).toHaveCount(0);
      await expect(page.getByTestId("viewer-canvas")).toBeHidden();
      await expect(close).toBeFocused(); // Closing does not steal focus.
      await page.keyboard.press(browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
      await expect(file).toBeFocused(); // Focus can move out; no trap.
    });
  });

  test("load, rendering, file errors and recovery expose busy/live/alert semantics", async ({ browserName }) => {
    await withBrowser(browserName, async page => {
      // Delay the local File read, so loading state can be inspected deterministically.
      await page.addInitScript(() => {
        const win = window as Window & { __releaseAccessibleRead?: () => void };
        const original = File.prototype.arrayBuffer;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        win.__releaseAccessibleRead = release;
        File.prototype.arrayBuffer = async function() {
          if (this.name === "accessible-slow.pdf") await held;
          return original.call(this);
        };
      });
      expect((await page.goto("./"))?.status()).toBe(200);
      const file = page.getByTestId("viewer-file");
      const status = page.getByTestId("viewer-state");
      await file.setInputFiles({
        name: "accessible-slow.pdf", mimeType: "application/pdf",
        buffer: await readFile(valid),
      });
      await expect(status).toContainText("Opening");
      await expect(status).toHaveAttribute("role", "status");
      await expect(status).toHaveAttribute("aria-live", "polite");
      await expect(status).toHaveAttribute("aria-atomic", "true");
      await expect(page.locator('[aria-label="Document page"]')).toHaveAttribute("aria-busy", "true");

      await page.evaluate(() => (window as Window & {
        __releaseAccessibleRead?: () => void;
      }).__releaseAccessibleRead?.());
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");
      await expect(page.locator('[aria-label="Document page"]')).toHaveAttribute("aria-busy", "false");
      await expect(status).toContainText("Page 1 of 2 ready.");

      await file.setInputFiles(corrupt.pathname);
      await expect(page.getByTestId("viewer-error-kind")).toHaveText("INVALID_DOCUMENT", { timeout: 30_000 });
      await expect(status).toHaveAttribute("role", "alert");
      await expect(status).toHaveAttribute("aria-live", "assertive");
      await expect(status).toContainText("could not be opened");
      await expect(page.getByTestId("viewer-canvas")).toBeHidden();

      await file.setInputFiles(protectedPdf.pathname);
      await expect(page.getByTestId("viewer-error-kind"))
        .toHaveText("PASSWORD_REQUIRED_OR_INVALID", { timeout: 30_000 });
      await expect(status).toContainText("password");
      await expect(status).toHaveAttribute("role", "alert");

      await file.setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
      await expect(status).toHaveAttribute("role", "status");
      await expect(status).toContainText("Page 1 of 2 ready.");

      await page.getByTestId("viewer-close").focus();
      await page.keyboard.press("Enter");
      await expect(status).toContainText("Choose a PDF");
      await expect(status).toHaveAttribute("role", "status");
    });
  });

  test("keyboard focus remains visible while a page render is pending and never traps the user", async ({ browserName }) => {
    await withBrowser(browserName, async page => {
      await page.addInitScript(() => {
        const win = window as Window & { __releaseA11yRender?: () => void };
        const original = Worker.prototype.postMessage as (
          this: Worker, message: unknown, transfer: Transferable[],
        ) => void;
        Worker.prototype.postMessage = function(this: Worker, message: unknown, transfer?: Transferable[]) {
          const req = message as { operation?: string; pageIndex?: number };
          if (!win.__releaseA11yRender &&
              req?.operation === "RENDER" && req.pageIndex === 1) {
            const target = this;
            win.__releaseA11yRender = () => original.call(target, message, transfer ?? []);
            return;
          }
          return original.call(this, message, transfer ?? []);
        } as typeof Worker.prototype.postMessage;
      });
      expect((await page.goto("./"))?.status()).toBe(200);
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
      const next = page.getByTestId("page-next");
      await next.focus();
      await page.keyboard.press("Enter");
      const status = page.getByTestId("viewer-state");
      await expect(status).toContainText("Rendering page 2");
      await expect(status).toHaveAttribute("role", "status");
      await expect(page.locator('[aria-label="Document page"]')).toHaveAttribute("aria-busy", "true");
      await expect(page.getByTestId("page-busy")).toContainText("Rendering");
      await expect(page.getByTestId("viewer-page-count")).toHaveCount(0);
      await expect(next).toBeDisabled();

      await page.getByTestId("page-previous").focus();
      await assertVisibleKeyboardFocus(page);
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("page-entry")).toBeFocused();
      await assertVisibleKeyboardFocus(page);

      await page.evaluate(() => {
        const release = (window as Window & {
          __releaseA11yRender?: () => void;
        }).__releaseA11yRender;
        if (!release) throw Error("Page render interception not reached");
        release();
      });
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 2 of 2");
      expect(await marker(page)).toEqual([0, 0, 255, 255]);
      await expect(page.getByTestId("page-busy")).toHaveCount(0);
      await expect(page.locator('[aria-label="Document page"]')).toHaveAttribute("aria-busy", "false");
    });
  });
});
