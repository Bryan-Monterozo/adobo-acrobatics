import { PDF_LIMITS, type PdfAdapter, type PdfOpenResult, type PdfPixelResult, type PdfRenderOptions } from "./types";
import { PdfWorkerError, publicMessage, safeError, type PdfOperation, type PdfWorkerRequest, type PdfWorkerResponse, type PdfWorkerStats } from "./protocol";

export interface PdfClientOptions {
  /** Unit-test seam; production always uses the module Worker below. */
  workerFactory?: () => Worker;
  requestTimeoutMs?: number;
}

type Pending = {
  operation: PdfOperation;
  generation: number;
  resolve(value: unknown): void;
  reject(reason: PdfWorkerError): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Browser-only factory; no Worker or native PDFium is created at import time. */
export function createPdfClient(
  basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  options: PdfClientOptions = {},
): PdfAdapter & { stats(): Promise<PdfWorkerStats> } {
  const worker = options.workerFactory
    ? options.workerFactory()
    : new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const workerEpoch = crypto.randomUUID();
  const origin = globalThis.location?.origin ?? "http://localhost";
  const assetUrl = new URL(basePath + "/pdfium/2.15.1/pdfium.wasm", origin).href;
  let requestId = 0;
  let generation = 0;
  let activeId: string | undefined;
  let ready: Promise<void> | undefined;
  let disposed = false;
  let disposing = false;
  let disposal: Promise<void> | undefined;
  let broken = false;
  const pending = new Map<number, Pending>();
  const deadline = options.requestTimeoutMs ?? PDF_LIMITS.requestTimeoutMs;

  function stop(kind: "WORKER_FAILED" | "SESSION_CLOSED" | "RUNTIME_LOAD" = "WORKER_FAILED") {
    if (broken) return;
    broken = true;
    activeId = undefined;
    generation++;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new PdfWorkerError({ kind, message: publicMessage(kind) }));
    }
    pending.clear();
    worker.terminate();
  }

  function invalidate() {
    generation++;
    for (const [id, item] of pending) {
      if (!["OPEN", "RENDER", "STATS"].includes(item.operation)) continue;
      pending.delete(id);
      clearTimeout(item.timer);
      item.reject(new PdfWorkerError({kind: "SESSION_CLOSED", message: publicMessage("SESSION_CLOSED")}));
    }
  }

  worker.onerror = (event) => {
    event.preventDefault?.();
    stop();
  };
  worker.onmessageerror = () => stop();
  worker.onmessage = ({ data }: MessageEvent<PdfWorkerResponse>) => {
    if (!data || data.workerEpoch !== workerEpoch) return;
    const entry = pending.get(data.requestId);
    if (!entry || entry.operation !== data.operation ||
        entry.generation !== data.documentGeneration) return;
    pending.delete(data.requestId);
    clearTimeout(entry.timer);
    if (["OPEN", "RENDER", "STATS"].includes(entry.operation) && entry.generation !== generation) {
      entry.reject(new PdfWorkerError({kind: "SESSION_CLOSED", message: publicMessage("SESSION_CLOSED")}));
      return;
    }
    if (data.ok) entry.resolve(data.value);
    else entry.reject(new PdfWorkerError(safeError(data.error)));
  };

  function send(operation: PdfWorkerRequest["operation"], payload: object = {},
                transfer: Transferable[] = [], maxMs = deadline): Promise<unknown> {
    if (broken || disposed || (disposing && operation !== "DISPOSE")) {
      return Promise.reject(new PdfWorkerError({
        kind: "WORKER_FAILED", message: publicMessage("WORKER_FAILED"),
      }));
    }
    const id = ++requestId;
    const envelope = { requestId: id, workerEpoch, documentGeneration: generation, operation, ...payload } as PdfWorkerRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(operation === "INIT" ? "RUNTIME_LOAD" : "WORKER_FAILED"), maxMs);
      pending.set(id, { resolve, reject, timer, operation, generation });
      try { worker.postMessage(envelope, transfer); }
      catch { stop(); }
    });
  }

  function ensureReady(): Promise<void> {
    if (disposed || disposing || broken) return Promise.reject(new PdfWorkerError({
      kind: "WORKER_FAILED", message: publicMessage("WORKER_FAILED"),
    }));
    if (!ready) {
      const attempt = send("INIT", { assetUrl }, [], PDF_LIMITS.initializationTimeoutMs + 1_000)
        .then(() => undefined);
      const tracked = attempt.catch((error: unknown) => {
        if (ready === tracked) ready = undefined;
        throw error;
      });
      ready = tracked;
    }
    return ready;
  }

  async function open(bytes: Uint8Array): Promise<PdfOpenResult> {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0)
      throw new PdfWorkerError({ kind: "INVALID_DOCUMENT", message: publicMessage("INVALID_DOCUMENT") });
    if (bytes.byteLength > PDF_LIMITS.maxInputBytes)
      throw new PdfWorkerError({ kind: "LIMIT_EXCEEDED", message: publicMessage("LIMIT_EXCEEDED") });
    // Never transfer the input view's original backing storage.
    const ownedCopy = new Uint8Array(bytes).buffer;
    invalidate();
    activeId = undefined;
    const ownGeneration = generation;
    await ensureReady();
    if (ownGeneration !== generation || disposed || disposing) throw new PdfWorkerError({kind:"SESSION_CLOSED",message:publicMessage("SESSION_CLOSED")});
    const result = await send("OPEN", { bytes: ownedCopy }, [ownedCopy]) as PdfOpenResult;
    if (ownGeneration !== generation) throw new PdfWorkerError({kind:"SESSION_CLOSED",message:publicMessage("SESSION_CLOSED")});
    activeId = result.sessionId;
    return result;
  }

  async function render(sessionId: string, pageIndex: number, renderOptions: PdfRenderOptions): Promise<PdfPixelResult> {
    const ownGeneration = generation;
    await ensureReady();
    if (ownGeneration !== generation) throw new PdfWorkerError({kind:"SESSION_CLOSED",message:publicMessage("SESSION_CLOSED")});
    if (!activeId || activeId !== sessionId) throw new PdfWorkerError({kind:"SESSION_CLOSED",message:publicMessage("SESSION_CLOSED")});
    return await send("RENDER", { sessionId, pageIndex, options: renderOptions }) as PdfPixelResult;
  }

  async function close(sessionId: string): Promise<void> {
    if (broken || disposed || disposing || activeId !== sessionId) return;
    invalidate();
    activeId = undefined;
    await ensureReady();
    await send("CLOSE", { sessionId });
  }

  async function stats(): Promise<PdfWorkerStats> {
    await ensureReady();
    return await send("STATS") as PdfWorkerStats;
  }

  async function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposing = true;
    invalidate();
    activeId = undefined;
    disposal = (async () => {
    try {
      if (!broken && ready) {
        await send("DISPOSE");
      }
    } catch {
      // Termination is still required when native cleanup fails.
    } finally {
      disposed = true;
      stop("SESSION_CLOSED");
    }
    })();
    return disposal;
  }

  return { ensureReady, open, render, close, dispose, stats };
}
