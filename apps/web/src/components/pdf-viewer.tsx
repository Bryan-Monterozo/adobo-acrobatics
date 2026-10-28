"use client";

import { useEffect, useRef, useState } from "react";
import PdfFileInput from "./pdf-file-input";
import PageNavigation from "./page-navigation";
import { validPageNumber } from "../viewer/page-state";
import { createPdfClient } from "../pdf/client";
import { clearPdfPixels, presentPdfPixels } from "../pdf/present-canvas";
import { selectBrowserDpr } from "../pdf/render-options";
import { PDF_LIMITS } from "../pdf/types";
import {
  emptyDocument, failedDocument, openingDocument,
  readyDocument, renderingDocument, type DocumentState,
} from "../viewer/document-state";

type WorkerClient = ReturnType<typeof createPdfClient>;

/** One local document and a serialized worker. No File is sent over the network. */
export default function PdfViewer() {
  const [state, setState] = useState<DocumentState>(emptyDocument);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<WorkerClient | null>(null);
  const sessionRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const pageGenerationRef = useRef(0);
  const currentPageRef = useRef(1);
  const pageCountRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // Worker construction is browser-only; cleanup terminates its native realm.
    const client = createPdfClient();
    clientRef.current = client;
    return () => {
      generationRef.current++;
      pageGenerationRef.current++;
      pageCountRef.current = 0;
      clientRef.current = null;
      sessionRef.current = null;
      clearPdfPixels(canvasRef.current);
      void client.dispose();
    };
  }, []);

  async function paintPage(
    client: WorkerClient, sessionId: string, pageNumber: number,
    pageCount: number, documentGeneration: number, pageGeneration: number,
  ) {
    const current = () =>
      clientRef.current === client &&
      sessionRef.current === sessionId &&
      generationRef.current === documentGeneration &&
      pageGenerationRef.current === pageGeneration;
    if (!current()) return;
    const pixels = await client.render(sessionId, pageNumber - 1, {
      scale: 1, rotation: 0, dpr: selectBrowserDpr(window.devicePixelRatio),
    });
    if (!current()) return;
    const canvas = canvasRef.current;
    if (!canvas) throw { kind: "RENDER_FAILED" };
    presentPdfPixels(canvas, pixels);
    canvas.style.width = `${pixels.displayWidth}px`;
    canvas.style.height = `${pixels.displayHeight}px`;
    setState(readyDocument(pageCount, pageNumber));
  }

  function navigate(pageNumber: number) {
    const client = clientRef.current;
    const sessionId = sessionRef.current;
    const pageCount = pageCountRef.current;
    if (!client || !sessionId || !validPageNumber(pageNumber, pageCount) ||
      pageNumber === currentPageRef.current) return;

    const documentGeneration = generationRef.current;
    const pageGeneration = ++pageGenerationRef.current;
    currentPageRef.current = pageNumber;
    clearPdfPixels(canvasRef.current);
    setState(renderingDocument(pageCount, pageNumber));

    const current = () =>
      clientRef.current === client &&
      sessionRef.current === sessionId &&
      generationRef.current === documentGeneration &&
      pageGenerationRef.current === pageGeneration;

    const task = queueRef.current.then(async () => {
      if (!current()) return;
      await paintPage(client, sessionId, pageNumber, pageCount, documentGeneration, pageGeneration);
    }).catch(async error => {
      if (!current()) return;
      sessionRef.current = null;
      pageCountRef.current = 0;
      clearPdfPixels(canvasRef.current);
      try { await client.close(sessionId); } catch { /* Worker failure stays recoverable by reopening. */ }
      if (generationRef.current !== documentGeneration ||
        pageGenerationRef.current !== pageGeneration) return;
      setState(failedDocument(error));
    });
    queueRef.current = task;
  }

  function choose(file: File) {
    const client = clientRef.current;
    if (!client) return;
    const generation = ++generationRef.current;
    pageGenerationRef.current++;
    currentPageRef.current = 1;
    pageCountRef.current = 0;
    const isCurrent = () =>
      generationRef.current === generation && clientRef.current === client;

    // Invalidate the displayed document immediately, even if old work is pending.
    clearPdfPixels(canvasRef.current);
    setState(openingDocument());

    const task = queueRef.current.then(async () => {
      const prior = sessionRef.current;
      sessionRef.current = null;
      if (prior) await client.close(prior); // Native FIFO: old render finishes first.
      if (!isCurrent()) return;

      // Reject before File.arrayBuffer() or any PDF bitmap/native allocation.
      if (file.size > PDF_LIMITS.maxInputBytes) {
        throw { kind: "LIMIT_EXCEEDED" };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrent()) return;
      const opened = await client.open(bytes);
      // A Close/replacement may have invalidated this async open. Its native
      // session still needs closing, even though it must never reach the UI.
      if (!isCurrent()) {
        await client.close(opened.sessionId);
        return;
      }
      sessionRef.current = opened.sessionId;

      pageCountRef.current = opened.pageCount;
      currentPageRef.current = 1;
      const pageGeneration = ++pageGenerationRef.current;
      setState(renderingDocument(opened.pageCount, 1));
      await paintPage(client, opened.sessionId, 1, opened.pageCount, generation, pageGeneration);
    }).catch(async error => {
      // Obsolete open failures must not release a newer document's session.
      if (!isCurrent()) return;
      // Failed opens/renders leave no retained session; later choices can retry.
      const id = sessionRef.current;
      sessionRef.current = null;
      if (id) {
        try { await client.close(id); } catch { /* Broken owner is disposed on unmount. */ }
      }
      if (!isCurrent()) return;
      pageGenerationRef.current++;
      pageCountRef.current = 0;
      currentPageRef.current = 1;
      clearPdfPixels(canvasRef.current);
      setState(failedDocument(error));
    });
    queueRef.current = task;
  }

  function closeDocument() {
    const client = clientRef.current;
    // Invalidate both in-flight document loads and page renders immediately.
    generationRef.current++;
    pageGenerationRef.current++;
    currentPageRef.current = 1;
    pageCountRef.current = 0;
    const ownedSession = sessionRef.current;
    sessionRef.current = null;
    const canvas = canvasRef.current;
    clearPdfPixels(canvas);
    if (canvas) {
      canvas.style.removeProperty("width");
      canvas.style.removeProperty("height");
    }
    setState(emptyDocument);

    // Native PDFium work is not cancellable mid-call. The UI is empty now,
    // but resource release is queued after earlier native requests finish.
    if (!client || !ownedSession) return;
    const task = queueRef.current.then(async () => {
      await client.close(ownedSession);
    }).catch(() => {
      // A broken worker terminates its entire realm. A later explicit open
      // is allowed to report a safe worker error instead of restoring pixels.
    });
    queueRef.current = task;
  }

  return (
    <section className="viewer-placeholder" aria-labelledby="viewer-heading"
      style={{ gap: "1.25rem", padding: "2rem 1.5rem" }}>
      <style>{`
        .viewer-placeholder :is(button, input):focus-visible {
          outline: 3px solid #185d45;
          outline-offset: 3px;
        }
      `}</style>
      <p className="eyebrow">Private PDF viewer</p>
      <h2 id="viewer-heading">Open a local PDF</h2>
      <PdfFileInput onSelect={choose} />
      <button type="button" data-testid="viewer-close" onClick={closeDocument}
        style={{ justifySelf: "center", font: "inherit", padding: "0.4rem 1rem" }}>
        Close document
      </button>
      <p data-testid="viewer-state"
        role={state.phase === "error" ? "alert" : "status"}
        aria-live={state.phase === "error" ? "assertive" : "polite"}
        aria-atomic="true"
        style={{ color: state.phase === "error" ? "#9c3434" : "#53685b", margin: 0 }}>
        {state.phase === "error" ? `Error: ${state.message}` : state.message}
      </p>
      {state.phase === "error" && (
        <p data-testid="viewer-error-kind" style={{ margin: 0, fontSize: "0.8rem" }}>
          {state.kind}
        </p>
      )}
      {(state.phase === "ready" || state.phase === "rendering") && (
        <PageNavigation
          pageNumber={state.pageNumber}
          pageCount={state.pageCount}
          busy={state.phase === "rendering"}
          onNavigate={navigate}
        />
      )}
      {state.phase === "ready" && (
        <p data-testid="viewer-page-count" style={{ fontWeight: 650, margin: 0 }}>
          Page {state.pageNumber} of {state.pageCount}
        </p>
      )}
      <div aria-label="Document page"
        aria-busy={state.phase === "opening" || state.phase === "rendering"}
        style={{
        maxWidth: "100%", maxHeight: "65vh", overflow: "auto",
        display: state.phase === "ready" ? "block" : "none",
        border: "1px solid #c4ccc3", background: "#fff",
      }}>
        <canvas ref={canvasRef} data-testid="viewer-canvas"
          aria-label={state.phase === "ready" || state.phase === "rendering"
            ? `Visual preview of page ${state.pageNumber} of ${state.pageCount}; PDF text is not available in this image`
            : "PDF page preview"}
          role="img"
          style={{ display: "block", maxWidth: "100%" }} />
      </div>
    </section>
  );
}
