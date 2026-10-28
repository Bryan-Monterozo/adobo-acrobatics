/// <reference lib="webworker" />
import { createPdfRuntime } from "./runtime";
import { createPdfDocumentOwner, type PdfDocumentOwner } from "./document";
import { createPdfPageRenderer, type PdfPageRenderer } from "./render";
import { safeError, type PdfWorkerRequest, type PdfWorkerResponse } from "./protocol";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let epoch: string | undefined;
let runtime: ReturnType<typeof createPdfRuntime> | undefined;
let documents: PdfDocumentOwner | undefined;
let renderer: PdfPageRenderer | undefined;
let activeId: string | undefined;
let operations: Promise<void> = Promise.resolve();

function respond(message: PdfWorkerResponse, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

async function run(request: PdfWorkerRequest): Promise<void> {
  const { requestId, workerEpoch, documentGeneration, operation } = request;
  if (epoch === undefined) epoch = workerEpoch;
  if (workerEpoch !== epoch) return; // Never reply to another worker's epoch.
  try {
    let response: PdfWorkerResponse;
    if (operation === "INIT") {
      runtime ??= createPdfRuntime(request.assetUrl);
      await runtime.ensureReady();
      response = { requestId, workerEpoch, documentGeneration, ok: true, operation, value: null };
    } else {
      if (!runtime) throw new Error("Runtime not initialized");
      const module = await runtime.getModule();
      documents ??= createPdfDocumentOwner(module);
      renderer ??= createPdfPageRenderer(module, documents);
      switch (operation) {
        case "OPEN": {
          // Close the previous native owner before allocating the next.
          if (activeId) { documents.close(activeId); activeId = undefined; }
          const opened = documents.open(new Uint8Array(request.bytes));
          activeId = opened.sessionId;
          response = { requestId, workerEpoch, documentGeneration, ok: true, operation, value: opened };
          break;
        }
        case "RENDER": {
          const pixels = renderer.render(request.sessionId, request.pageIndex, request.options);
          response = { requestId, workerEpoch, documentGeneration, ok: true, operation, value: pixels };
          respond(response, [pixels.rgba]);
          return;
        }
        case "CLOSE":
          documents.close(request.sessionId);
          if (activeId === request.sessionId) activeId = undefined;
          response = { requestId, workerEpoch, documentGeneration, ok: true, operation, value: null };
          break;
        case "STATS":
          response = { requestId, workerEpoch, documentGeneration, ok: true, operation, value: documents.stats() };
          break;
        case "DISPOSE":
          if (activeId) { documents.close(activeId); activeId = undefined; }
          response = { requestId, workerEpoch, documentGeneration, ok: true, operation, value: null };
          break;
      }
    }
    respond(response);
  } catch (error) {
    respond({
      requestId, workerEpoch, documentGeneration, operation, ok: false,
      error: safeError(error, operation === "INIT" ? "RUNTIME_LOAD" : "WORKER_FAILED"),
    });
  }
}

scope.onmessage = ({ data }: MessageEvent<PdfWorkerRequest>) => {
  // A rejected native operation must not poison subsequent queued requests.
  operations = operations.then(() => run(data), () => run(data)).catch(() => {});
};
