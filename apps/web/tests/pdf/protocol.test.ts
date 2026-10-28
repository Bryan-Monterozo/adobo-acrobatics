import { describe, expect, it, vi } from "vitest";
import { createPdfClient } from "../../src/pdf/client";
import { safeError, type PdfWorkerRequest, type PdfWorkerResponse } from "../../src/pdf/protocol";

function mockWorker() {
  const commands: PdfWorkerRequest[] = [];
  const transfers: Transferable[][] = [];
  let terminated = 0;
  let active = "";
  const worker = {
    onmessage: null as ((event: MessageEvent<PdfWorkerResponse>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage(request: PdfWorkerRequest, transfer: Transferable[]) {
      commands.push(request);
      transfers.push(transfer);
      queueMicrotask(() => {
        const common = {
          requestId: request.requestId, workerEpoch: request.workerEpoch,
          documentGeneration: request.documentGeneration,
        };
        let response: PdfWorkerResponse;
        if (request.operation === "OPEN") {
          active = "session-" + request.requestId;
          response = { ...common, ok: true, operation: "OPEN", value: { sessionId: active, pageCount: 2 } };
        } else if (request.operation === "RENDER") {
          response = { ...common, ok: true, operation: "RENDER", value: {
            width: 1, height: 1, displayWidth: 1, displayHeight: 1,
            rgba: new Uint8Array([255, 0, 0, 255]).buffer,
          } };
        } else if (request.operation === "STATS") {
          response = { ...common, ok: true, operation: "STATS", value: {
            activeDocuments: active ? 1 : 0, activeAllocations: active ? 1 : 0,
          } };
        } else {
          if (request.operation === "CLOSE" || request.operation === "DISPOSE") active = "";
          response = { ...common, ok: true, operation: request.operation, value: null };
        }
        worker.onmessage?.({ data: response } as MessageEvent<PdfWorkerResponse>);
      });
    },
    terminate() { terminated++; },
  };
  return { worker: worker as unknown as Worker, commands, transfers, terminated: () => terminated };
}

describe("E07a dedicated-worker RPC", () => {
  it("opens, renders, closes in order with transferable owned input and opaque results", async () => {
    const mock = mockWorker();
    const client = createPdfClient("", { workerFactory: () => mock.worker });
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    await client.ensureReady();
    const opened = await client.open(bytes);
    expect(bytes).toEqual(Uint8Array.from([1, 2, 3, 4]));
    const pixels = await client.render(opened.sessionId, 0, { scale: 1, rotation: 0, dpr: 1 });
    expect(Array.from(new Uint8Array(pixels.rgba))).toEqual([255, 0, 0, 255]);
    await client.close(opened.sessionId);
    expect(mock.commands.map(x => x.operation)).toEqual(["INIT", "OPEN", "RENDER", "CLOSE"]);
    const req = mock.commands[1];
    if (req.operation !== "OPEN") throw Error("wrong envelope");
    expect(req.bytes).not.toBe(bytes.buffer);
    expect(mock.transfers[1]).toEqual([req.bytes]);
    expect(new Set(mock.commands.map(x => x.workerEpoch)).size).toBe(1);
    expect(new Set(mock.commands.map(x => x.requestId)).size).toBe(4);
    expect(JSON.stringify(mock.commands)).not.toMatch(/handle|pointer|fileName/);
    await client.dispose();
    expect(mock.terminated()).toBe(1);
  });

  it("shares one initialization request for concurrent callers", async () => {
    const mock = mockWorker();
    const client = createPdfClient("", { workerFactory: () => mock.worker });
    await Promise.all([client.ensureReady(), client.ensureReady(), client.ensureReady()]);
    expect(mock.commands.filter(c => c.operation === "INIT")).toHaveLength(1);
    await client.dispose();
  });

  it("rejects every pending operation after an unexpected worker error", async () => {
    const mock = mockWorker();
    const client = createPdfClient("", { workerFactory: () => mock.worker });
    await client.ensureReady();
    mock.worker.postMessage = vi.fn();
    const operation = client.open(Uint8Array.from([1, 2]));
    await Promise.resolve();
    mock.worker.onerror?.({ preventDefault() {} } as ErrorEvent);
    await expect(operation).rejects.toMatchObject({ kind: "WORKER_FAILED" });
    await expect(client.ensureReady()).rejects.toMatchObject({ kind: "WORKER_FAILED" });
    expect(mock.terminated()).toBe(1);
  });

  it("ignores replies with the wrong epoch, ID, or generation", async () => {
    const mock = mockWorker();
    const client = createPdfClient("", { workerFactory: () => mock.worker });
    await client.ensureReady();
    mock.worker.postMessage = vi.fn();
    const operation = client.open(Uint8Array.from([1]));
    await Promise.resolve();
    const init = mock.commands[0];
    for (const changed of [
      { workerEpoch: "another-epoch" },
      { requestId: 999 },
      { documentGeneration: 888 },
    ]) {
      mock.worker.onmessage?.({ data: {
        requestId: init.requestId + 1, workerEpoch: init.workerEpoch,
        documentGeneration: init.documentGeneration, operation: "OPEN", ok: true,
        value: { sessionId: "invalid", pageCount: 1 },
        ...changed,
      } } as MessageEvent<PdfWorkerResponse>);
    }
    let settled = false;
    operation.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    mock.worker.onmessageerror?.({} as MessageEvent);
    await expect(operation).rejects.toMatchObject({ kind: "WORKER_FAILED" });
    expect(mock.terminated()).toBe(1);
  });

  it("sanitizes unknown and known failures without copying raw messages", () => {
    expect(safeError({ kind: "NOT_AN_APP_KIND", message: "private data" })).toEqual({
      kind: "WORKER_FAILED",
      message: "The PDF worker stopped. Please retry with a new session.",
    });
    const error = safeError({ kind: "INVALID_DOCUMENT", nativeCode: 4, message: "private data" });
    expect(error).toMatchObject({ kind: "INVALID_DOCUMENT", nativeCode: 4 });
    expect(error.message).not.toContain("private data");
    expect(safeError({ kind: "INVALID_DOCUMENT", nativeCode: -1 })).not.toHaveProperty("nativeCode");
  });
  it("terminates a stalled native request at the bounded watchdog", async () => {
    const mock = mockWorker();
    const client = createPdfClient("", { workerFactory: () => mock.worker, requestTimeoutMs: 50 });
    await client.ensureReady();
    mock.worker.postMessage = vi.fn();
    vi.useFakeTimers();
    try {
      const stalled = client.open(Uint8Array.from([1]));
      const outcome = expect(stalled).rejects.toMatchObject({ kind: "WORKER_FAILED" });
      await vi.advanceTimersByTimeAsync(50);
      await outcome;
      expect(mock.terminated()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports stalled initialization as RUNTIME_LOAD and terminates the owner", async () => {
    const mock = mockWorker();
    mock.worker.postMessage = vi.fn();
    vi.useFakeTimers();
    try {
      const client = createPdfClient("", { workerFactory: () => mock.worker });
      const requested = client.ensureReady();
      const outcome = expect(requested).rejects.toMatchObject({ kind: "RUNTIME_LOAD" });
      await vi.advanceTimersByTimeAsync(16_000);
      await outcome;
      expect(mock.terminated()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

});
