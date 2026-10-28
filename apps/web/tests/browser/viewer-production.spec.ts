import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:3100";
const prefix = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const wasmPath = prefix + "/pdfium/2.15.1/pdfium.wasm";
const wasmSha = "5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa";
const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);
const corrupt = new URL("../fixtures/pdf/corrupt.pdf", import.meta.url);
const protectedPdf = new URL("../fixtures/pdf/protected-two-page.pdf", import.meta.url);

type BrowserName = "chromium" | "firefox" | "webkit";

async function withRealBrowser(
  name: BrowserName, run: (page: Page, version: string) => Promise<void>,
) {
  const browserType = { chromium, firefox, webkit }[name];
  // macOS L09: use Playwright's matching full Chromium, not the unstable headless-shell.
  const browser = await browserType.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try {
      await run(await context.newPage(), browser.version());
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

async function blueSinglePage(): Promise<Buffer> {
  const PdfKit = createRequire(import.meta.url)("pdfkit");
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PdfKit({ size: [200, 300], margin: 0, compress: false });
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.rect(0, 0, 200, 300).fill("#ffffff");
    pdf.rect(20, 20, 80, 80).fill("#0000ff");
    pdf.end();
  });
}

async function pixel(page: Page) {
  return await page.getByTestId("viewer-canvas").evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    return {
      geometry: [canvas.width, canvas.height],
      color: Array.from(canvas.getContext("2d")!.getImageData(40, 40, 1, 1).data),
    };
  });
}

test.describe("P05.03 S08 real-worker production viewer", () => {
  test("same-origin worker/WASM, full open→navigate→replace→failure→reopen→close/reload journey",
    async ({ browserName }) => {
      await withRealBrowser(browserName as BrowserName, async (page, version) => {
        console.log(`P05.03 ${browserName}=${version}; prefix=${prefix || "/"}; platform=${process.platform}/${process.arch}`);
        const requests: Array<{ method: string; url: string }> = [];
        const wasm: Array<{ status: number; type: string }> = [];
        const workers: string[] = [];
        const pageErrors: string[] = [];
        page.on("request", req => requests.push({ method: req.method(), url: req.url() }));
        page.on("response", res => {
          if (new URL(res.url()).pathname === wasmPath)
            wasm.push({ status: res.status(), type: res.headers()["content-type"] ?? "" });
        });
        page.on("worker", worker => workers.push(worker.url()));
        page.on("pageerror", err => pageErrors.push(err.message));

        const response = await page.goto("./", { waitUntil: "domcontentloaded" });
        expect(response?.status()).toBe(200);
        expect([prefix || "/", prefix + "/"]).toContain(new URL(page.url()).pathname);
        const chooser = page.getByTestId("viewer-file");
        const count = page.getByTestId("viewer-page-count");
        const status = page.getByTestId("viewer-state");
        await expect(status).toContainText("Choose a PDF");

        await chooser.setInputFiles(valid.pathname);
        await expect(count).toHaveText("Page 1 of 2", { timeout: 30_000 });
        expect(await pixel(page)).toEqual({ geometry: [200, 300], color: [255, 0, 0, 255] });
        await page.getByTestId("page-next").click();
        await expect(count).toHaveText("Page 2 of 2");
        expect(await pixel(page)).toEqual({ geometry: [200, 300], color: [0, 0, 255, 255] });
        await page.getByTestId("page-entry").fill("1");
        await page.getByTestId("page-go").click();
        await expect(count).toHaveText("Page 1 of 2");
        expect(await pixel(page).then(x => x.color)).toEqual([255, 0, 0, 255]);

        const blue = await blueSinglePage();
        await chooser.setInputFiles({ name: "local-production-b.pdf",
          mimeType: "application/pdf", buffer: blue });
        await expect(count).toHaveText("Page 1 of 1", { timeout: 30_000 });
        expect(await pixel(page).then(x => x.color)).toEqual([0, 0, 255, 255]);
        await expect(page.getByTestId("page-next")).toBeDisabled();

        await chooser.setInputFiles(corrupt.pathname);
        await expect(page.getByTestId("viewer-error-kind"))
          .toHaveText("INVALID_DOCUMENT", { timeout: 30_000 });
        await expect(page.getByTestId("viewer-canvas")).toBeHidden();
        await expect(count).toHaveCount(0);
        await chooser.setInputFiles(protectedPdf.pathname);
        await expect(page.getByTestId("viewer-error-kind"))
          .toHaveText("PASSWORD_REQUIRED_OR_INVALID", { timeout: 30_000 });

        await chooser.setInputFiles(valid.pathname);
        await expect(count).toHaveText("Page 1 of 2", { timeout: 30_000 });
        await page.getByTestId("viewer-close").click();
        await expect(status).toContainText("Choose a PDF");
        await expect(count).toHaveCount(0);
        await expect(page.getByTestId("viewer-canvas")).toBeHidden();
        expect(await page.getByTestId("viewer-canvas").evaluate(el => {
          const c = el as HTMLCanvasElement;
          return [c.width, c.height];
        })).toEqual([0, 0]);

        await chooser.setInputFiles(valid.pathname);
        await expect(count).toHaveText("Page 1 of 2", { timeout: 30_000 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(status).toContainText("Choose a PDF");
        await expect(count).toHaveCount(0);
        await expect(page.getByTestId("viewer-canvas")).toBeHidden();

        expect(wasm.length).toBeGreaterThan(0);
        // Worker-owned fetch bodies are not consistently accessible through
        // Playwright. Verify the identical same-origin asset URL independently.
        const asset = await fetch(origin + wasmPath);
        expect(asset.status).toBe(200);
        expect((asset.headers.get("content-type") ?? "").toLowerCase())
          .toContain("application/wasm");
        const wasmBytes = Buffer.from(await asset.arrayBuffer());
        expect(wasmBytes.length).toBe(4_646_932);
        expect(createHash("sha256").update(wasmBytes).digest("hex")).toBe(wasmSha);
        for (const result of wasm) {
          expect(result.status).toBe(200);
          expect(result.type.toLowerCase()).toContain("application/wasm");
        }
        expect(workers.length).toBeGreaterThan(0);
        for (const workerUrl of workers) {
          const u = new URL(workerUrl);
          expect(u.origin).toBe(origin);
          expect(u.pathname).toContain(prefix + "/_next/static/chunks/");
          expect(u.pathname.endsWith(".js")).toBe(true);
        }
        for (const req of requests) {
          expect(new URL(req.url).origin).toBe(origin);
          expect(["GET", "HEAD"]).toContain(req.method);
          expect(new URL(req.url).pathname).not.toMatch(/\.pdf$/);
        }
        expect(pageErrors).toEqual([]);
      });
    });

  test("late page render never restores pixels after Close and a new PDF opens", async ({ browserName }) => {
    await withRealBrowser(browserName as BrowserName, async page => {
      await page.addInitScript(() => {
        const win = window as Window & { __releaseProductionRender?: () => void };
        const send = Worker.prototype.postMessage as (
          this: Worker, message: unknown, transfer: Transferable[],
        ) => void;
        Worker.prototype.postMessage = function(this: Worker, message: unknown, transfer?: Transferable[]) {
          const req = message as { operation?: string; pageIndex?: number };
          if (!win.__releaseProductionRender && req?.operation === "RENDER" && req.pageIndex === 1) {
            const worker = this;
            win.__releaseProductionRender = () => send.call(worker, message, transfer ?? []);
            return;
          }
          return send.call(this, message, transfer ?? []);
        } as typeof Worker.prototype.postMessage;
      });
      expect((await page.goto("./"))?.status()).toBe(200);
      const chooser = page.getByTestId("viewer-file");
      const count = page.getByTestId("viewer-page-count");
      await chooser.setInputFiles(valid.pathname);
      await expect(count).toHaveText("Page 1 of 2", { timeout: 30_000 });
      await page.getByTestId("page-next").click();
      await expect(page.getByTestId("viewer-state")).toContainText("Rendering page 2");
      await page.getByTestId("viewer-close").click();
      await expect(count).toHaveCount(0);
      await expect(page.getByTestId("viewer-canvas")).toBeHidden();
      await page.evaluate(() => {
        const release = (window as Window & { __releaseProductionRender?: () => void })
          .__releaseProductionRender;
        if (!release) throw Error("Expected intercepted page-2 render");
        release();
      });
      await chooser.setInputFiles(valid.pathname);
      await expect(count).toHaveText("Page 1 of 2", { timeout: 30_000 });
      expect(await pixel(page).then(x => x.color)).toEqual([255, 0, 0, 255]);
      await page.getByTestId("viewer-close").click();
      await expect(count).toHaveCount(0);
    });
  });
});
