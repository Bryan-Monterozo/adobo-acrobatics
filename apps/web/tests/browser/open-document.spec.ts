import { createRequire } from "node:module";
import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";

const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);
const corrupt = new URL("../fixtures/pdf/corrupt.pdf", import.meta.url);
const empty = new URL("../fixtures/pdf/empty.pdf", import.meta.url);
const protectedPdf = new URL("../fixtures/pdf/protected-two-page.pdf", import.meta.url);

async function blueFixture(): Promise<Buffer> {
  const PdfKit = createRequire(import.meta.url)("pdfkit");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PdfKit({
      size: [200, 300], margin: 0, compress: false,
      info: { Title: "Local blue test page" },
    });
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("error", (error: Error) => reject(error));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.rect(0, 0, 200, 300).fill("#ffffff");
    pdf.rect(20, 20, 80, 80).fill("#0000ff");
    pdf.end();
  });
}

async function inBrowser(name: string, check: (page: Page) => Promise<void>) {
  const browserType = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!browserType) throw Error("Unknown Playwright browser");
  // L09: use the Playwright-installed full Chromium rather than unstable headless-shell.
  const browser = await browserType.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try {
      const requests: Array<{ url: string; method: string }> = [];
      context.on("request", req => requests.push({ url: req.url(), method: req.method() }));
      await check(await context.newPage());
      expect(requests.length).toBeGreaterThan(0);
      for (const req of requests) {
        expect(new URL(req.url).origin).toBe("http://127.0.0.1:3100");
        expect(["GET", "HEAD"]).toContain(req.method);
        expect(new URL(req.url).pathname).not.toMatch(/\.pdf$/);
      }
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

async function color(page: Page): Promise<number[]> {
  return page.getByTestId("viewer-canvas").evaluate(element =>
    Array.from((element as HTMLCanvasElement).getContext("2d")!
      .getImageData(40, 40, 1, 1).data));
}

test.describe("P03.01 public local PDF viewer", () => {
  test("opens the red two-page fixture, cancel preserves it; B replaces it; failures recover", async ({ browserName }) => {
    const blue = await blueFixture();
    await inBrowser(browserName, async page => {
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      expect((await page.goto("./"))?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Adobo Acrobatics" })).toBeVisible();
      const file = page.getByTestId("viewer-file");
      const status = page.getByTestId("viewer-state");
      const count = page.getByTestId("viewer-page-count");
      const canvas = page.getByTestId("viewer-canvas");
      await expect(file).toBeVisible();
      await expect(status).toContainText("Choose a PDF");

      await file.setInputFiles(valid.pathname);
      await expect(count).toHaveText("Page 1 of 2", { timeout: 30_000 });
      expect(await color(page)).toEqual([255, 0, 0, 255]);
      expect(await canvas.evaluate(c => [(c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height]))
        .toEqual([200, 300]);

      await file.dispatchEvent("cancel");
      await expect(count).toHaveText("Page 1 of 2");
      expect(await color(page)).toEqual([255, 0, 0, 255]);

      // B has different contents and page count, ensuring A cannot be mistaken for B.
      await file.setInputFiles({ name: "local-blue.pdf", mimeType: "application/pdf", buffer: blue });
      await expect(count).toHaveText("Page 1 of 1", { timeout: 30_000 });
      expect(await color(page)).toEqual([0, 0, 255, 255]);

      for (const [path, kind] of [
        [empty.pathname, "INVALID_DOCUMENT"],
        [corrupt.pathname, "INVALID_DOCUMENT"],
        [protectedPdf.pathname, "PASSWORD_REQUIRED_OR_INVALID"],
      ]) {
        await file.setInputFiles(path);
        await expect(page.getByTestId("viewer-error-kind")).toHaveText(kind, { timeout: 30_000 });
        await expect(count).toHaveCount(0);
        await expect(canvas).toBeHidden();
        expect(await canvas.evaluate(c => [(c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height]))
          .toEqual([0, 0]);
        await file.setInputFiles(valid.pathname);
        await expect(count).toHaveText("Page 1 of 2", { timeout: 30_000 });
        expect(await color(page)).toEqual([255, 0, 0, 255]);
      }
      expect(errors).toEqual([]);
    });
  });

  test("oversized input is rejected before arrayBuffer and valid retry succeeds", async ({ browserName }) => {
    await inBrowser(browserName, async page => {
      expect((await page.goto("./"))?.status()).toBe(200);
      await page.evaluate(() => {
        const w = window as Window & { __fileReadCount?: number };
        w.__fileReadCount = 0;
        const old = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function () {
          w.__fileReadCount = (w.__fileReadCount ?? 0) + 1;
          return old.call(this);
        };
        const file = new File([new Uint8Array(26_214_401)], "over.pdf",
          { type: "application/pdf" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const input = document.querySelector('[data-testid="viewer-file"]') as HTMLInputElement;
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect(page.getByTestId("viewer-error-kind")).toHaveText("LIMIT_EXCEEDED");
      expect(await page.evaluate(() => (window as Window & { __fileReadCount?: number }).__fileReadCount))
        .toBe(0);
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
      expect(await color(page)).toEqual([255, 0, 0, 255]);
    });
  });

  test("a delayed A read never restores A after B was selected", async ({ browserName }) => {
    const blue = await blueFixture();
    await inBrowser(browserName, async page => {
      expect((await page.goto("./"))?.status()).toBe(200);
      await page.evaluate(() => {
        const w = window as Window & { __releaseSlowRead?: () => void };
        const original = File.prototype.arrayBuffer;
        let release!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        w.__releaseSlowRead = release;
        File.prototype.arrayBuffer = async function () {
          if (this.name === "slow-first.pdf") await hold;
          return original.call(this);
        };
      });
      const input = page.getByTestId("viewer-file");
      await input.setInputFiles({
        name: "slow-first.pdf", mimeType: "application/pdf",
        buffer: await (await import("node:fs/promises")).readFile(valid),
      });
      await expect(page.getByTestId("viewer-state")).toContainText("Opening");
      await input.setInputFiles({ name: "second-blue.pdf", mimeType: "application/pdf", buffer: blue });
      await expect(page.getByTestId("viewer-page-count")).toHaveCount(0);
      await expect(page.getByTestId("viewer-canvas")).toBeHidden();
      await page.evaluate(() => (window as Window & { __releaseSlowRead?: () => void }).__releaseSlowRead?.());
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 1", { timeout: 30_000 });
      expect(await color(page)).toEqual([0, 0, 255, 255]);
    });
  });
});
