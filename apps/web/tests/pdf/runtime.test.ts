import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { createPdfRuntime, PdfRuntimeLoadError } from "../../src/pdf/runtime";

const ORIGIN = "https://adobo.example";
const ASSET = ORIGIN + "/pdfium/2.15.1/pdfium.wasm";
const MAGIC = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);

function wasmResponse(bytes: Uint8Array = MAGIC, status = 200): Response {
  return new Response(Uint8Array.from(bytes).buffer, {
    status,
    headers: { "content-type": "application/wasm" },
  });
}

function harness() {
  const initExtension = vi.fn();
  const module = { PDFiumExt_Init: initExtension } as unknown as WrappedPdfiumModule;
  const fetchWasm = vi.fn(async (_url: string, _options: RequestInit) => wasmResponse());
  const initModule = vi.fn(async (_options: { wasmBinary: ArrayBuffer }) => module);
  const origin = vi.fn(() => ORIGIN);
  return {
    module,
    initExtension,
    fetchWasm,
    initModule,
    origin,
    create: (url = ASSET) =>
      createPdfRuntime(url, { origin, fetchWasm, initModule }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PDFium readiness ownership", () => {
  it("passes owned bytes to init, then calls extension exactly once and caches readiness", async () => {
    const h = harness();
    const runtime = h.create();
    await runtime.ensureReady();
    expect(h.fetchWasm).toHaveBeenCalledWith(
      ASSET,
      expect.objectContaining({
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(h.initModule).toHaveBeenCalledTimes(1);
    const options = h.initModule.mock.calls[0]?.[0];
    expect(new Uint8Array(options?.wasmBinary)).toEqual(MAGIC);
    expect(h.initExtension).toHaveBeenCalledTimes(1);
    expect(await runtime.getModule()).toBe(h.module);
    await runtime.ensureReady();
    expect(h.fetchWasm).toHaveBeenCalledTimes(1);
    expect(h.initModule).toHaveBeenCalledTimes(1);
    expect(h.initExtension).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight promise and never exposes a module before extension readiness", async () => {
    const h = harness();
    let release!: (value: WrappedPdfiumModule) => void;
    h.initModule.mockImplementationOnce(
      () => new Promise<WrappedPdfiumModule>((resolve) => { release = resolve; }),
    );
    const runtime = h.create();
    const first = runtime.ensureReady();
    const second = runtime.ensureReady();
    expect(first).toBe(second);
    const delivered = vi.fn();
    const reader = runtime.getModule().then(delivered);
    await vi.waitFor(() => expect(h.initModule).toHaveBeenCalledTimes(1));
    expect(delivered).not.toHaveBeenCalled();
    expect(h.initExtension).not.toHaveBeenCalled();
    expect(h.fetchWasm).toHaveBeenCalledTimes(1);
    release(h.module);
    await Promise.all([first, second, reader]);
    expect(delivered).toHaveBeenCalledWith(h.module);
    expect(h.initExtension).toHaveBeenCalledTimes(1);
  });
});

describe("PDFium startup validation and recovery", () => {
  it.each([
    "/pdfium/2.15.1/pdfium.wasm",
    "https://other.example/pdfium/2.15.1/pdfium.wasm",
    "file:///pdfium/2.15.1/pdfium.wasm",
    ORIGIN + "/other.wasm",
    ORIGIN + "/pdfium/2.15.1/pdfium.wasm?token=1",
    ORIGIN + "/pdfium/2.15.1/pdfium.wasm#fragment",
    "https://someone@adobo.example/pdfium/2.15.1/pdfium.wasm",
  ])("rejects unsafe URL %s before fetching", async (url) => {
    const h = harness();
    await expect(h.create(url).ensureReady()).rejects.toMatchObject({ kind: "RUNTIME_LOAD" });
    expect(h.fetchWasm).not.toHaveBeenCalled();
  });

  it("rejects HTTP 404 then retries successfully", async () => {
    const h = harness();
    h.fetchWasm.mockResolvedValueOnce(wasmResponse(MAGIC, 404));
    const runtime = h.create();
    await expect(runtime.ensureReady()).rejects.toBeInstanceOf(PdfRuntimeLoadError);
    expect(h.initModule).not.toHaveBeenCalled();
    await runtime.ensureReady();
    expect(h.fetchWasm).toHaveBeenCalledTimes(2);
    expect(h.initExtension).toHaveBeenCalledTimes(1);
  });

  it("normalizes a fetch failure then recovers", async () => {
    const h = harness();
    h.fetchWasm.mockRejectedValueOnce(new Error("private network diagnostic"));
    const runtime = h.create();
    await expect(runtime.ensureReady()).rejects.toMatchObject({
      kind: "RUNTIME_LOAD",
      message: "The PDF engine could not be initialized. Please try again.",
    });
    await runtime.ensureReady();
    expect(h.initModule).toHaveBeenCalledTimes(1);
  });

  it.each([
    Uint8Array.from([]),
    Uint8Array.from([0, 97, 115, 109]),
    Uint8Array.from([0, 97, 115, 109, 2, 0, 0, 0]),
    Uint8Array.from([60, 104, 116, 109, 108, 62, 0, 0]),
  ])("rejects bad WASM headers and recovers", async (badBytes) => {
    const h = harness();
    h.fetchWasm.mockResolvedValueOnce(wasmResponse(badBytes));
    const runtime = h.create();
    await expect(runtime.ensureReady()).rejects.toMatchObject({ kind: "RUNTIME_LOAD" });
    expect(h.initModule).not.toHaveBeenCalled();
    await runtime.ensureReady();
    expect(h.initExtension).toHaveBeenCalledTimes(1);
  });

  it("normalizes a failed module init, then retries", async () => {
    const h = harness();
    h.initModule.mockRejectedValueOnce(new Error("WASM init failed"));
    const runtime = h.create();
    await expect(runtime.getModule()).rejects.toMatchObject({ kind: "RUNTIME_LOAD" });
    expect(h.initExtension).not.toHaveBeenCalled();
    await runtime.ensureReady();
    expect(h.initModule).toHaveBeenCalledTimes(2);
    expect(h.initExtension).toHaveBeenCalledTimes(1);
  });

  it("retries after extension initialization throws", async () => {
    const h = harness();
    h.initExtension.mockImplementationOnce(() => { throw new Error("extension failed"); });
    const runtime = h.create();
    await expect(runtime.ensureReady()).rejects.toMatchObject({ kind: "RUNTIME_LOAD" });
    await runtime.ensureReady();
    expect(h.initExtension).toHaveBeenCalledTimes(2);
  });
});

describe("15-second startup budget", () => {
  it("times out a stalled fetch, aborts the request and permits retry", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fetchWasm.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const runtime = h.create();
    const first = runtime.ensureReady();
    const rejection = expect(first).rejects.toMatchObject({ kind: "RUNTIME_LOAD" });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    const originalSignal = h.fetchWasm.mock.calls[0]?.[1].signal;
    expect(originalSignal?.aborted).toBe(true);
    await runtime.ensureReady();
    expect(h.fetchWasm).toHaveBeenCalledTimes(2);
    expect(h.initExtension).toHaveBeenCalledTimes(1);
  });

  it("does not publish a late module from a timed-out attempt", async () => {
    vi.useFakeTimers();
    const h = harness();
    let release!: (module: WrappedPdfiumModule) => void;
    h.initModule.mockImplementationOnce(
      () => new Promise<WrappedPdfiumModule>((resolve) => { release = resolve; }),
    );
    const runtime = h.create();
    const first = runtime.ensureReady();
    const rejection = expect(first).rejects.toMatchObject({ kind: "RUNTIME_LOAD" });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    release(h.module);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.initExtension).not.toHaveBeenCalled();
    await runtime.ensureReady();
    expect(h.initModule).toHaveBeenCalledTimes(2);
    expect(h.initExtension).toHaveBeenCalledTimes(1);
  });
});
