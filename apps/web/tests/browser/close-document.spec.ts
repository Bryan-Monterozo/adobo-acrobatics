import { chromium, firefox, webkit, expect, test, type Page } from "@playwright/test";

const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);
const corrupt = new URL("../fixtures/pdf/corrupt.pdf", import.meta.url);

type RequestRecord = { operation: string; requestId: number };
type Probe = {
  worker?: Worker;
  epoch?: string;
  log: RequestRecord[];
  delayOperation?: "OPEN" | "RENDER";
  delayPageIndex?: number;
  release?: () => void;
  nextId: number;
};

async function isolated(name: string, run: (page: Page) => Promise<void>) {
  const browserType = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!browserType) throw Error("Unknown browser");
  // Keep the established L09 Playwright-installed full Chromium test isolation.
  const browser = await browserType.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try {
      const requests: Array<{ method: string; url: string }> = [];
      context.on("request", req => requests.push({ method: req.method(), url: req.url() }));
      const page = await context.newPage();
      await page.addInitScript(() => {
        const win = window as Window & { __p03CloseProbe?: Probe };
        const probe: Probe = { log: [], nextId: 1_000_000 };
        win.__p03CloseProbe = probe;
        const send = Worker.prototype.postMessage as (
          this: Worker, message: unknown, transfer: Transferable[],
        ) => void;
        Worker.prototype.postMessage = function(this: Worker, message: unknown, transfer?: Transferable[]) {
          const req = message as {
            operation?: string; requestId?: number; workerEpoch?: string; pageIndex?: number;
          } | null;
          if (req && typeof req.operation === "string") {
            probe.worker = this;
            probe.epoch = req.workerEpoch;
            probe.log.push({ operation: req.operation, requestId: req.requestId ?? -1 });
            if (probe.delayOperation === req.operation &&
                (probe.delayPageIndex === undefined || probe.delayPageIndex === req.pageIndex)) {
              probe.delayOperation = undefined;
              probe.release = () => send.call(this, message, transfer ?? []);
              return;
            }
          }
          return send.call(this, message, transfer ?? []);
        } as typeof Worker.prototype.postMessage;
      });
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

async function liveStats(page: Page) {
  return page.evaluate(async () => {
    const probe = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe;
    if (!probe?.worker || !probe.epoch) throw Error("Worker not observed");
    const id = ++probe.nextId;
    const worker = probe.worker;
    return await new Promise<{ activeDocuments: number; activeAllocations: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener("message", receive);
        reject(Error("Worker stats timed out"));
      }, 6_000);
      function receive(event: MessageEvent) {
        const msg = event.data as {
          requestId?: number; operation?: string; ok?: boolean;
          value?: { activeDocuments: number; activeAllocations: number };
        };
        if (msg.requestId !== id || msg.operation !== "STATS") return;
        clearTimeout(timer);
        worker.removeEventListener("message", receive);
        if (!msg.ok || !msg.value) reject(Error("STATS failed"));
        else resolve(msg.value);
      }
      worker.addEventListener("message", receive);
      // Diagnostic RPC with a distinct ID; the application's client ignores
      // responses not in its pending-request map.
      worker.postMessage({
        operation: "STATS", requestId: id, workerEpoch: probe.epoch, documentGeneration: 0,
      });
    });
  });
}

async function emptyView(page: Page) {
  await expect(page.getByTestId("viewer-state")).toContainText("Choose a PDF");
  await expect(page.getByTestId("viewer-page-count")).toHaveCount(0);
  await expect(page.getByTestId("viewer-error-kind")).toHaveCount(0);
  await expect(page.getByTestId("page-entry")).toHaveCount(0);
  await expect(page.getByTestId("viewer-canvas")).toBeHidden();
  expect(await page.getByTestId("viewer-canvas").evaluate(element => [
    (element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height,
  ])).toEqual([0, 0]);
}

async function readMarker(page: Page) {
  return page.getByTestId("viewer-canvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    return Array.from(canvas.getContext("2d")!.getImageData(40, 40, 1, 1).data);
  });
}

test.describe("P03.03 public Close / reopen", () => {
  test("close twice clears page, navigation and error; reopen navigates and closes resources", async ({ browserName }) => {
    await isolated(browserName, async page => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      expect((await page.goto("./"))?.status()).toBe(200);
      const file = page.getByTestId("viewer-file");
      const close = page.getByTestId("viewer-close");
      await file.setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
      await page.getByTestId("page-next").click();
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 2 of 2");
      expect(await readMarker(page)).toEqual([0, 0, 255, 255]);

      await close.click();
      await emptyView(page);
      await close.click(); // Repeated Close is harmless.
      await emptyView(page);
      await page.waitForFunction(() => {
        const probe = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe;
        return !!probe?.log.some(item => item.operation === "CLOSE");
      });
      expect(await liveStats(page)).toEqual({ activeDocuments: 0, activeAllocations: 0 });
      expect(await page.evaluate(() =>
        (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe?.log
          .filter(item => item.operation === "CLOSE").length)).toBe(1);

      await file.setInputFiles(corrupt.pathname);
      await expect(page.getByTestId("viewer-error-kind")).toHaveText("INVALID_DOCUMENT", { timeout: 30_000 });
      await close.click();
      await emptyView(page);
      await close.click();
      await emptyView(page);

      await file.setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
      expect(await readMarker(page)).toEqual([255, 0, 0, 255]);
      await page.getByTestId("page-next").click();
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 2 of 2");
      expect(await readMarker(page)).toEqual([0, 0, 255, 255]);
      await close.click();
      await emptyView(page);
      await page.waitForFunction(() => {
        const probe = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe;
        return (probe?.log.filter(item => item.operation === "CLOSE").length ?? 0) === 2;
      });
      expect(await liveStats(page)).toEqual({ activeDocuments: 0, activeAllocations: 0 });
      expect(errors).toEqual([]);
    });
  });

  test("Close during a delayed page render hides old pixels and ignores late output", async ({ browserName }) => {
    await isolated(browserName, async page => {
      expect((await page.goto("./"))?.status()).toBe(200);
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");
      await page.evaluate(() => {
        const probe = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe!;
        probe.delayOperation = "RENDER";
        probe.delayPageIndex = 1;
      });
      await page.getByTestId("page-next").click();
      await expect(page.getByTestId("viewer-state")).toContainText("Rendering page 2");
      await page.getByTestId("viewer-close").click();
      await emptyView(page);
      await page.evaluate(() => {
        const release = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe?.release;
        if (!release) throw Error("Delayed render was not captured");
        release();
      });
      await page.waitForFunction(() => {
        const probe = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe;
        return !!probe?.log.some(item => item.operation === "CLOSE");
      });
      expect(await liveStats(page)).toEqual({ activeDocuments: 0, activeAllocations: 0 });
      await emptyView(page); // Delayed result must not resurrect a page.
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");
      expect(await readMarker(page)).toEqual([255, 0, 0, 255]);
    });
  });

  test("Close during delayed native OPEN closes late-acquired handle before reopening", async ({ browserName }) => {
    await isolated(browserName, async page => {
      expect((await page.goto("./"))?.status()).toBe(200);
      await page.evaluate(() => {
        const probe = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe!;
        probe.delayOperation = "OPEN";
      });
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-state")).toContainText("Opening");
      await page.waitForFunction(() => !!(window as Window & {
        __p03CloseProbe?: Probe;
      }).__p03CloseProbe?.release);
      await page.getByTestId("viewer-close").click();
      await emptyView(page);
      await page.evaluate(() => {
        const release = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe?.release;
        if (!release) throw Error("Delayed open was not captured");
        release();
      });
      await page.waitForFunction(() => {
        const probe = (window as Window & { __p03CloseProbe?: Probe }).__p03CloseProbe;
        return !!probe?.log.some(item => item.operation === "CLOSE");
      });
      expect(await liveStats(page)).toEqual({ activeDocuments: 0, activeAllocations: 0 });
      await emptyView(page);
      await page.getByTestId("viewer-file").setInputFiles(valid.pathname);
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
      await page.getByTestId("page-next").click();
      await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 2 of 2");
      expect(await readMarker(page)).toEqual([0, 0, 255, 255]);
    });
  });
});
