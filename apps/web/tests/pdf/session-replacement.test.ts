import { describe, expect, it } from "vitest";
import { createPdfClient } from "../../src/pdf/client";
import type { PdfWorkerRequest, PdfWorkerResponse } from "../../src/pdf/protocol";

function fake() {
  const messages: PdfWorkerRequest[] = [];
  const renders: PdfWorkerResponse[] = [];
  let terminations = 0;
  const worker = {
    onmessage: null as ((event: MessageEvent<PdfWorkerResponse>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage(req: PdfWorkerRequest) {
      messages.push(req);
      const ids = { requestId: req.requestId, workerEpoch: req.workerEpoch,
        documentGeneration: req.documentGeneration };
      let response: PdfWorkerResponse;
      if (req.operation === "OPEN") response = { ...ids, ok: true, operation: "OPEN",
        value: { sessionId: "session-" + req.requestId, pageCount: 2 } };
      else if (req.operation === "RENDER") response = { ...ids, ok: true, operation: "RENDER",
        value: { width: 1, height: 1, displayWidth: 1, displayHeight: 1, rgba: new ArrayBuffer(4) } };
      else if (req.operation === "STATS") response = { ...ids, ok: true, operation: "STATS",
        value: { activeDocuments: 0, activeAllocations: 0 } };
      else response = { ...ids, ok: true, operation: req.operation, value: null };
      if (req.operation === "RENDER") renders.push(response);
      else queueMicrotask(() => worker.onmessage?.({ data: response } as MessageEvent<PdfWorkerResponse>));
    },
    terminate() { terminations++; },
  };
  return { worker: worker as unknown as Worker, messages,
    terminated: () => terminations,
    release() {
      const message = renders.shift();
      if (!message) throw Error("No deferred render");
      worker.onmessage?.({ data: message } as MessageEvent<PdfWorkerResponse>);
    },
  };
}
const bytes = () => Uint8Array.from([37, 80, 68, 70]);
const options = { scale: 1 as const, rotation: 0 as const, dpr: 1 };

describe("E07b stale-session handling", () => {
  it("rejects delayed render A after opening B; B remains current", async () => {
    const mock = fake();
    const client = createPdfClient("", { workerFactory: () => mock.worker });
    const original = bytes();
    const first = await client.open(original);
    const delayed = client.render(first.sessionId, 0, options);
    await Promise.resolve();
    const failed = expect(delayed).rejects.toMatchObject({ kind: "SESSION_CLOSED" });
    const second = await client.open(bytes());
    await failed;
    mock.release();
    expect(original).toEqual(bytes());
    expect(second.sessionId).not.toBe(first.sessionId);
    const current = client.render(second.sessionId, 1, options);
    await Promise.resolve();
    mock.release();
    expect((await current).width).toBe(1);
    await client.close(second.sessionId);
    expect(mock.messages.map(m => m.operation)).toEqual(["INIT","OPEN","RENDER","OPEN","RENDER","CLOSE"]);
    await client.dispose();
    expect(mock.terminated()).toBe(1);
  });

  it("settles active renders on close while native close stays queued", async () => {
    const mock = fake();
    const client = createPdfClient("", { workerFactory: () => mock.worker });
    const first = await client.open(bytes());
    const render = client.render(first.sessionId, 0, options);
    await Promise.resolve();
    const rejected = expect(render).rejects.toMatchObject({ kind: "SESSION_CLOSED" });
    await client.close(first.sessionId);
    await rejected;
    mock.release();
    await expect(client.render(first.sessionId, 0, options)).rejects.toMatchObject({ kind: "SESSION_CLOSED" });
    expect(mock.messages.map(m => m.operation)).toEqual(["INIT","OPEN","RENDER","CLOSE"]);
    await client.dispose();
  });

  it("dispose rejects queued renders and acknowledges native disposal", async () => {
    const mock = fake();
    const client = createPdfClient("", { workerFactory: () => mock.worker });
    const document = await client.open(bytes());
    const render = client.render(document.sessionId, 0, options);
    await Promise.resolve();
    const rejected = expect(render).rejects.toMatchObject({ kind: "SESSION_CLOSED" });
    await client.dispose();
    await rejected;
    mock.release();
    expect(mock.messages.map(m => m.operation)).toEqual(["INIT","OPEN","RENDER","DISPOSE"]);
    expect(mock.terminated()).toBe(1);
    await expect(client.open(bytes())).rejects.toMatchObject({ kind: "WORKER_FAILED" });
  });
});
