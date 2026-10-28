import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import {
  chromium, firefox, webkit, expect, test,
  type BrowserContext, type Page,
} from "@playwright/test";

const origin = "http://127.0.0.1:3100";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const valid = new URL("../fixtures/pdf/valid-two-page.pdf", import.meta.url);
const corrupt = new URL("../fixtures/pdf/corrupt.pdf", import.meta.url);
const protectedPdf = new URL("../fixtures/pdf/protected-two-page.pdf", import.meta.url);

type PrivacyAudit = { writes: string[] };
type PersistentSnapshot = {
  localStorage: string[];
  sessionStorage: string[];
  indexedDbNames: string[];
  cacheNames: string[];
  cookies: string;
  serviceWorkers: number;
  writes: string[];
};
type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyLength: number;
};

function permittedPath(path: string): boolean {
  return path === basePath + "/" ||
    (basePath !== "" && path === basePath) ||
    path === basePath + "/favicon.ico" ||
    path === basePath + "/pdfium/2.15.1/pdfium.wasm" ||
    path.startsWith(basePath + "/_next/static/");
}

async function bluePageWithUniqueMetadata(secret: string): Promise<Buffer> {
  const PdfKit = createRequire(import.meta.url)("pdfkit");
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PdfKit({
      size: [200, 300], margin: 0, compress: false,
      info: { Title: secret, Author: secret },
    });
    pdf.on("data", (part: Buffer) => chunks.push(part));
    pdf.on("error", (error: Error) => reject(error));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.rect(0, 0, 200, 300).fill("#ffffff");
    pdf.rect(20, 20, 80, 80).fill("#0000ff");
    pdf.end();
  });
}

async function instrumentBrowserStorage(context: BrowserContext) {
  await context.addInitScript(() => {
    const audit: PrivacyAudit = { writes: [] };
    const scope = window as Window & { __adoboPrivacyAudit?: PrivacyAudit };
    scope.__adoboPrivacyAudit = audit;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      audit.writes.push("Storage.setItem:" + key);
      return set.call(this, key, value);
    };
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(key: string) {
      audit.writes.push("Storage.removeItem:" + key);
      return remove.call(this, key);
    };
    const clear = Storage.prototype.clear;
    Storage.prototype.clear = function() {
      audit.writes.push("Storage.clear");
      return clear.call(this);
    };
    const idbOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((...args: Parameters<IDBFactory["open"]>) => {
      audit.writes.push("indexedDB.open");
      return idbOpen(...args);
    }) as IDBFactory["open"];
    if (typeof CacheStorage !== "undefined") {
      const originalOpen = CacheStorage.prototype.open;
      CacheStorage.prototype.open = function(name: string) {
        audit.writes.push("CacheStorage.open:" + name);
        return originalOpen.call(this, name);
      };
    }
    if (typeof navigator.serviceWorker !== "undefined") {
      const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = ((...args: Parameters<ServiceWorkerContainer["register"]>) => {
        audit.writes.push("serviceWorker.register");
        return register(...args);
      }) as ServiceWorkerContainer["register"];
    }
    if (typeof navigator.storage?.getDirectory === "function") {
      const getDirectory = navigator.storage.getDirectory.bind(navigator.storage);
      navigator.storage.getDirectory = () => {
        audit.writes.push("navigator.storage.getDirectory");
        return getDirectory();
      };
    }
    const cookieProperty = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (cookieProperty?.configurable && cookieProperty.set) {
      const cookieSetter = cookieProperty.set;
      Object.defineProperty(Document.prototype, "cookie", {
        ...cookieProperty,
        set(value: string) {
          audit.writes.push("document.cookie");
          cookieSetter.call(this, value);
        },
      });
    }
    if (typeof Cache !== "undefined") {
      const put = Cache.prototype.put;
      Cache.prototype.put = function(request, response) {
        audit.writes.push("Cache.put");
        return put.call(this, request, response);
      };
      const add = Cache.prototype.add;
      Cache.prototype.add = function(request) {
        audit.writes.push("Cache.add");
        return add.call(this, request);
      };
      const addAll = Cache.prototype.addAll;
      Cache.prototype.addAll = function(requests) {
        audit.writes.push("Cache.addAll");
        return addAll.call(this, requests);
      };
    }
  });
}

async function snapshot(page: Page): Promise<PersistentSnapshot> {
  return await page.evaluate(async () => {
    const records = async () => {
      if (typeof indexedDB.databases !== "function") return [];
      return (await indexedDB.databases()).map(db => db.name ?? "").sort();
    };
    const serviceWorkers = navigator.serviceWorker
      ? (await navigator.serviceWorker.getRegistrations()).length : 0;
    const scope = window as Window & { __adoboPrivacyAudit?: PrivacyAudit };
    return {
      localStorage: Object.keys(localStorage).sort(),
      sessionStorage: Object.keys(sessionStorage).sort(),
      indexedDbNames: await records(),
      cacheNames: typeof caches === "undefined" ? [] : (await caches.keys()).sort(),
      cookies: document.cookie,
      serviceWorkers,
      writes: [...(scope.__adoboPrivacyAudit?.writes ?? [])],
    };
  });
}

function emptyStorage(state: PersistentSnapshot) {
  expect(state).toEqual({
    localStorage: [],
    sessionStorage: [],
    indexedDbNames: [],
    cacheNames: [],
    cookies: "",
    serviceWorkers: 0,
    writes: [],
  });
}

async function assertPrivate(page: Page, context: BrowserContext, requests: RecordedRequest[],
  violations: string[], stage: string) {
  expect(violations, stage + ": blocked network attempts").toEqual([]);
  expect(requests.length, stage + ": no network traffic observed").toBeGreaterThan(0);
  for (const req of requests) {
    expect(req.method, stage + " HTTP method").toMatch(/^(GET|HEAD)$/);
    expect(req.bodyLength, stage + " request body bytes").toBe(0);
    const url = new URL(req.url);
    expect(url.origin, stage + " request origin").toBe(origin);
    expect(permittedPath(url.pathname), stage + " request path " + url.pathname).toBe(true);
  }
  emptyStorage(await snapshot(page));
  expect(await context.cookies()).toEqual([]);
  const persisted = await context.storageState({ indexedDB: true });
  expect(persisted.cookies, stage + " persisted cookies").toEqual([]);
  // Playwright's typed storageState exposes cookies/localStorage; IndexedDB
  // is checked through the live browser snapshot above.
  expect(persisted.origins.every(item => item.localStorage.length === 0),
    stage + " persisted localStorage").toBe(true);
}

async function pixel(page: Page) {
  return await page.getByTestId("viewer-canvas").evaluate(el =>
    Array.from((el as HTMLCanvasElement).getContext("2d")!
      .getImageData(40, 40, 1, 1).data));
}

test.describe("P05.01 production local-only PDF processing", () => {
  test("document bytes/name never travel over requests or persist through open, navigate, replace, error, close and reload",
    async ({ browserName }) => {
      const type = { chromium, firefox, webkit }[browserName];
      const browser = await type.launch(browserName === "chromium" ? { channel: "chromium" } : {});
      try {
        const context = await browser.newContext({
          baseURL: test.info().project.use.baseURL as string,
        });
        try {
          await instrumentBrowserStorage(context);
          const requests: RecordedRequest[] = [];
          const violations: string[] = [];
          const fingerprint = randomBytes(12).toString("hex");
          const secretFileA = "PRIVATE_FILENAME_A_" + fingerprint + ".pdf";
          const secretFileB = "PRIVATE_FILENAME_B_" + fingerprint + ".pdf";
          const secretContent = "PRIVATE_PDF_CONTENT_" + fingerprint;
          const bytesA = await readFile(valid);
          const bytesB = await bluePageWithUniqueMetadata(secretContent);
          expect(bytesB.includes(Buffer.from(secretContent))).toBe(true);
          const secrets = [secretFileA, secretFileB, secretContent];
          const expectedRoot = basePath + "/";
          await context.route("**/*", async route => {
            const request = route.request();
            const url = new URL(request.url());
            const body = request.postDataBuffer();
            const headers = await request.allHeaders();
            const record = {
              method: request.method(), url: request.url(), headers,
              bodyLength: body?.length ?? 0,
            };
            requests.push(record);
            const requestText = record.url + JSON.stringify(headers);
            const leak = secrets.some(secret => requestText.includes(secret) ||
              (body !== null && body.includes(Buffer.from(secret))));
            const allowed = url.origin === origin && permittedPath(url.pathname) &&
              url.search === "" && url.hash === "" &&
              ["GET", "HEAD"].includes(record.method) && !body?.length && !leak;
            if (!allowed) {
              violations.push(record.method + " " + url.pathname +
                (leak ? " [document data detected]" : " [unexpected endpoint/body]"));
              await route.abort();
            } else {
              await route.continue();
            }
          });

          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", e => pageErrors.push(e.message));
          expect((await page.goto("./", { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
          expect([expectedRoot, ...(basePath ? [basePath] : [])]).toContain(
            new URL(page.url()).pathname,
          );
          await expect(page.getByTestId("viewer-state")).toContainText("Choose a PDF");
          await assertPrivate(page, context, requests, violations, "initial load");

          const picker = page.getByTestId("viewer-file");
          await picker.setInputFiles({ name: secretFileA, mimeType: "application/pdf", buffer: bytesA });
          await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
          expect(await pixel(page)).toEqual([255, 0, 0, 255]);
          await assertPrivate(page, context, requests, violations, "open local file A");

          await page.getByTestId("page-next").click();
          await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 2 of 2");
          expect(await pixel(page)).toEqual([0, 0, 255, 255]);
          await page.getByTestId("page-previous").click();
          await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2");
          await assertPrivate(page, context, requests, violations, "navigate pages");

          await picker.setInputFiles({ name: secretFileB, mimeType: "application/pdf", buffer: bytesB });
          await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 1", { timeout: 30_000 });
          expect(await pixel(page)).toEqual([0, 0, 255, 255]);
          await assertPrivate(page, context, requests, violations, "replace A with B");

          await picker.setInputFiles(corrupt.pathname);
          await expect(page.getByTestId("viewer-error-kind")).toHaveText("INVALID_DOCUMENT", { timeout: 30_000 });
          await expect(page.getByTestId("viewer-canvas")).toBeHidden();
          await assertPrivate(page, context, requests, violations, "corrupt PDF failure");

          await picker.setInputFiles(protectedPdf.pathname);
          await expect(page.getByTestId("viewer-error-kind"))
            .toHaveText("PASSWORD_REQUIRED_OR_INVALID", { timeout: 30_000 });
          await assertPrivate(page, context, requests, violations, "protected PDF failure");

          await picker.setInputFiles({ name: secretFileA, mimeType: "application/pdf", buffer: bytesA });
          await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 2", { timeout: 30_000 });
          await page.getByTestId("viewer-close").click();
          await expect(page.getByTestId("viewer-state")).toContainText("Choose a PDF");
          await expect(page.getByTestId("viewer-page-count")).toHaveCount(0);
          await expect(page.getByTestId("viewer-canvas")).toBeHidden();
          await assertPrivate(page, context, requests, violations, "close document");

          await picker.setInputFiles({ name: secretFileB, mimeType: "application/pdf", buffer: bytesB });
          await expect(page.getByTestId("viewer-page-count")).toHaveText("Page 1 of 1", { timeout: 30_000 });
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(page.getByTestId("viewer-state")).toContainText("Choose a PDF");
          await expect(page.getByTestId("viewer-page-count")).toHaveCount(0);
          await expect(page.getByTestId("viewer-canvas")).toBeHidden();
          expect(await page.getByTestId("viewer-file").evaluate(
            el => (el as HTMLInputElement).files?.length ?? 0)).toBe(0);
          await assertPrivate(page, context, requests, violations, "reload after open");
          expect(pageErrors).toEqual([]);
          // Request allowlisting was enforced before each network request was sent.
          expect(requests.some(req =>
            new URL(req.url).pathname === basePath + "/pdfium/2.15.1/pdfium.wasm")).toBe(true);
          expect(requests.some(req => new URL(req.url).pathname.startsWith(basePath + "/_next/static/"))).toBe(true);
          expect(requests.every(req => !secrets.some(secret =>
            (req.url + JSON.stringify(req.headers)).includes(secret)))).toBe(true);
        } finally { await context.close(); }
      } finally { await browser.close(); }
    });
});
