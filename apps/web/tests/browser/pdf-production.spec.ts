import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit, expect, test, type Page, type Response } from "@playwright/test";

const enabled = process.env.ADOBO_ENGINE_CHECK !== "0";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const origin = "http://127.0.0.1:3100";
const assetPath = basePath + "/pdfium/2.15.1/pdfium.wasm";
const expectedWasmSha = "5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa";
const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);

async function isolatedBrowser(name: string, check: (page: Page) => Promise<void>) {
  const type = { chromium, firefox, webkit }[name as "chromium" | "firefox" | "webkit"];
  if (!type) throw Error("Unexpected browser");
  const browser = await type.launch(name === "chromium" ? { channel: "chromium" } : {});
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    try { await check(await context.newPage()); }
    finally { await context.close(); }
  } finally { await browser.close(); }
}

test.describe("E09 production delivery (root and /adobo-test rebuild)", () => {
  test.skip(!enabled, "requires request-time engineering gate");

  test("loads the exact matched WASM and bundled Worker under the deployment prefix", async ({ browserName }) => {
    const fixture = Array.from(await readFile(valid));
    await isolatedBrowser(browserName, async page => {
      const requests: Array<{ url: string; method: string }> = [];
      const wasmResponses: Response[] = [];
      const workerUrls: string[] = [];
      page.on("worker", worker => workerUrls.push(worker.url()));
      const pageErrors: string[] = [];
      page.on("request", req => requests.push({ url: req.url(), method: req.method() }));
      page.on("response", response => {
        if (new URL(response.url()).pathname === assetPath) wasmResponses.push(response);
      });
      page.on("pageerror", error => pageErrors.push(error.message));
      const first = await page.goto("./engine-check", { waitUntil: "domcontentloaded" });
      expect(first?.status()).toBe(200);
      await page.waitForFunction(() => Boolean(window.__adoboEngineCheck?.worker));

      const result = await page.evaluate(async input => {
        const client = window.__adoboEngineCheck!.worker;
        await client.ready();
        const doc = await client.open(Uint8Array.from(input));
        const pixels = await client.render(doc.sessionId, 0, { scale: 1, rotation: 0, dpr: 1 });
        const sample = Array.from(new Uint8Array(pixels.rgba, (40 * pixels.width + 40) * 4, 4));
        await client.close(doc.sessionId);
        const stats = await client.stats();
        await client.dispose();
        return { pageCount: doc.pageCount, sample, backing: [pixels.width, pixels.height], stats };
      }, fixture);
      expect(result).toEqual({
        pageCount: 2, sample: [255, 0, 0, 255], backing: [200, 300],
        stats: { activeDocuments: 0, activeAllocations: 0 },
      });

      expect(wasmResponses).toHaveLength(1);
      expect(wasmResponses[0].status()).toBe(200);
      expect((wasmResponses[0].headers()["content-type"] ?? "").toLowerCase()).toContain("application/wasm");
      // Some browser drivers cannot expose the body of a worker-owned fetch.
      // Verify the exact same-origin HTTP endpoint independently instead.
      const assetResponse = await fetch(origin + assetPath);
      expect(assetResponse.status).toBe(200);
      expect((assetResponse.headers.get("content-type") ?? "").toLowerCase()).toContain("application/wasm");
      const bytes = Buffer.from(await assetResponse.arrayBuffer());
      expect(bytes.byteLength).toBe(4_646_932);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedWasmSha);
      expect(Array.from(bytes.subarray(0, 8))).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);

      const urls = requests.map(r => new URL(r.url));
      // The actual Worker event is authoritative; chunk file names are hashed.
      expect(workerUrls.length).toBeGreaterThan(0);
      for (const workerUrl of workerUrls) {
        const url = new URL(workerUrl);
        expect(url.origin).toBe(origin);
        expect(url.pathname).toContain(basePath + "/_next/static/chunks/");
        expect(url.pathname.endsWith(".js")).toBe(true);
      }
      expect(urls.some(url => url.pathname === assetPath)).toBe(true);
      for (const req of requests) {
        const url = new URL(req.url);
        expect(url.origin).toBe(origin);
        expect(["GET", "HEAD"]).toContain(req.method);
        if (url.pathname !== "/favicon.ico") {
          expect(url.pathname.startsWith(basePath + "/")).toBe(true);
        }
      }
      expect(pageErrors).toEqual([]);
    });
  });

  test("missing WASM fails safely then succeeds on a subsequent explicit INIT", async ({ browserName }) => {
    await isolatedBrowser(browserName, async page => {
      let requested = 0;
      await page.route("**/pdfium/2.15.1/pdfium.wasm", async route => {
        requested++;
        if (requested === 1) await route.fulfill({ status: 404, body: "missing" });
        else await route.continue();
      });
      expect((await page.goto("./engine-check"))?.status()).toBe(200);
      await page.waitForFunction(() => Boolean(window.__adoboEngineCheck?.worker));
      const result = await page.evaluate(async () => {
        const client = window.__adoboEngineCheck!.worker;
        let kind = "";
        try { await client.ready(); } catch (error) { kind = (error as { kind: string }).kind; }
        await client.ready();
        const stats = await client.stats();
        await client.dispose();
        return { kind, stats };
      });
      expect(result).toEqual({
        kind: "RUNTIME_LOAD",
        stats: { activeDocuments: 0, activeAllocations: 0 },
      });
      expect(requested).toBe(2);
    });
  });
});

test.describe("E09 release engineering gate", () => {
  test.skip(enabled, "requires production release flag");
  test("denies private harness with normal build and query bypass", async ({ browserName }) => {
    await isolatedBrowser(browserName, async page => {
      const requests: string[] = [];
      page.on("request", request => requests.push(request.url()));
      expect((await page.goto("./engine-check"))?.status()).toBe(404);
      expect((await page.goto("./engine-check?ADOBO_ENGINE_CHECK=1"))?.status()).toBe(404);
      const root = await page.goto("./");
      expect(root?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Adobo Acrobatics" })).toBeVisible();
      expect(await page.evaluate(() => "__adoboEngineCheck" in window)).toBe(false);
      expect(await page.locator('[data-testid="harness-file"]').count()).toBe(0);
      expect(requests.filter(request => new URL(request).pathname === assetPath)).toEqual([]);
    });
  });
});
