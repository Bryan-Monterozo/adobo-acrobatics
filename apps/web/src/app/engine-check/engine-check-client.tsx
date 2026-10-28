"use client";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { createPdfRuntime } from "../../pdf/runtime";
import { createPdfClient } from "../../pdf/client";
import { clearPdfPixels, presentPdfPixels } from "../../pdf/present-canvas";
import { selectBrowserDpr } from "../../pdf/render-options";
import { PDF_LIMITS } from "../../pdf/types";
import { createPdfDocumentOwner, type PdfDocumentOwner } from "../../pdf/document";
import { createPdfPageRenderer, type PdfPageRenderer } from "../../pdf/render";
import type { PdfOpenResult, PdfPixelResult, PdfRenderOptions } from "../../pdf/types";
export type EngineCheckStats = {
  attempts: number;
  successes: number;
  failures: number;
  nativeCalls: number;
  ready: boolean;
  activeDocuments: number;
  activeAllocations: number;
};
export interface EngineCheckDriver {
  ready(): Promise<void>;
  open(bytes: Uint8Array): Promise<PdfOpenResult>;
  close(sessionId: string): void;
  render(sessionId: string, pageIndex: number, options: PdfRenderOptions): Promise<PdfPixelResult>;
  stats(): EngineCheckStats;
  worker: {
    ready(): Promise<void>;
    open(bytes: Uint8Array): Promise<PdfOpenResult>;
    render(sessionId: string, pageIndex: number, options: PdfRenderOptions): Promise<PdfPixelResult>;
    close(sessionId: string): Promise<void>;
    stats(): Promise<{ activeDocuments: number; activeAllocations: number }>;
    dispose(): Promise<void>;
  };
}
declare global {
  interface Window {
    __adoboEngineCheck?: EngineCheckDriver;
  }
}
type HarnessView = { phase: "idle" | "loading" | "ready" | "error"; pageCount: number; message: string };

export default function EngineCheckClient({ basePath }: { basePath: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<ReturnType<typeof createPdfClient> | null>(null);
  const sessionRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const [view, setView] = useState<HarnessView>({
    phase: "idle", pageCount: 0, message: "Choose a local PDF to inspect its first page.",
  });
  useEffect(() => {
    const url = new URL(basePath + "/pdfium/2.15.1/pdfium.wasm", window.location.origin).href;
    const runtime = createPdfRuntime(url);
    const workerClient = createPdfClient(basePath);
    clientRef.current = workerClient;
    let active = true;
    let attempts = 0;
    let successes = 0;
    let failures = 0;
    let nativeCalls = 0;
    let isReady = false;
    let documents: PdfDocumentOwner | undefined;
    let renderer: PdfPageRenderer | undefined;
    let activeSessionId: string | undefined;
    const driver: EngineCheckDriver = {
      worker: {
        ready: () => workerClient.ensureReady(),
        open: (bytes) => workerClient.open(bytes),
        render: (sessionId, pageIndex, options) => workerClient.render(sessionId, pageIndex, options),
        close: (sessionId) => workerClient.close(sessionId),
        stats: () => workerClient.stats(),
        dispose: () => workerClient.dispose(),
      },
      async ready() {
        if (!active) throw new Error("Engineering client is closed");
        attempts++;
        try {
          const module = await runtime.getModule();
          if (!active) throw new Error("Engineering client is closed");
          const code = module.FPDF_GetLastError();
          if (!Number.isInteger(code) || code < 0) throw new Error("Invalid native diagnostic code");
          nativeCalls++;
          isReady = true;
          successes++;
        } catch (error) {
          failures++;
          throw error;
        }
      },
      async open(bytes) {
        if (!active) throw new Error("Engineering client is closed");
        const module = await runtime.getModule();
        if (!active) throw new Error("Engineering client is closed");
        documents ??= createPdfDocumentOwner(module);
        const result = documents.open(bytes);
        activeSessionId = result.sessionId;
        return result;
      },
      close(sessionId) {
        if (!active) throw new Error("Engineering client is closed");
        documents?.close(sessionId);
        if (activeSessionId === sessionId) activeSessionId = undefined;
      },
      async render(sessionId, pageIndex, options) {
        if (!active) throw new Error("Engineering client is closed");
        const module = await runtime.getModule();
        if (!active || !documents) throw new Error("Engineering client is closed");
        renderer ??= createPdfPageRenderer(module, documents);
        return renderer.render(sessionId, pageIndex, options);
      },
      stats() {
        return {
          attempts, successes, failures, nativeCalls, ready: isReady,
          activeDocuments: documents?.stats().activeDocuments ?? 0,
          activeAllocations: documents?.stats().activeAllocations ?? 0,
        };
      },
    };
    window.__adoboEngineCheck = driver;
    return () => {
      active = false;
      generationRef.current++;
      sessionRef.current = null;
      clientRef.current = null;
      clearPdfPixels(canvasRef.current);
      void workerClient.dispose();
      if (activeSessionId) documents?.close(activeSessionId);
      activeSessionId = undefined;
      if (window.__adoboEngineCheck === driver) delete window.__adoboEngineCheck;
    };
  }, [basePath]);

  async function openLocalFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = ""; // Permit selecting the same file again.
    if (!file) return; // Cancel does not affect the displayed document.
    const client = clientRef.current;
    if (!client) return;
    const ticket = ++generationRef.current;
    const previousSession = sessionRef.current;
    sessionRef.current = null;
    clearPdfPixels(canvasRef.current);
    setView({ phase: "loading", pageCount: 0, message: "Opening local PDF…" });
    try {
      // Even a rejected replacement must release the previous document.
      if (previousSession) await client.close(previousSession);
      if (ticket !== generationRef.current || clientRef.current !== client) return;
      if (file.size > PDF_LIMITS.maxInputBytes) {
        throw { kind: "LIMIT_EXCEEDED", message: "The PDF exceeds supported resource limits." };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (ticket !== generationRef.current || clientRef.current !== client) return;
      const opened = await client.open(bytes);
      if (ticket !== generationRef.current || clientRef.current !== client) {
        await client.close(opened.sessionId);
        return;
      }
      sessionRef.current = opened.sessionId;
      const pixels = await client.render(opened.sessionId, 0, {
        scale: 1, rotation: 0, dpr: selectBrowserDpr(window.devicePixelRatio),
      });
      if (ticket !== generationRef.current || clientRef.current !== client) return;
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("The PDF page could not be displayed.");
      presentPdfPixels(canvas, pixels);
      setView({ phase: "ready", pageCount: opened.pageCount, message: "First page ready." });
    } catch (error) {
      if (ticket !== generationRef.current || clientRef.current !== client) return;
      clearPdfPixels(canvasRef.current);
      const message = error && typeof error === "object" && "message" in error &&
        typeof error.message === "string" ? error.message : "The PDF could not be displayed.";
      setView({ phase: "error", pageCount: 0, message });
    }
  }

  async function closeLocalFile() {
    const client = clientRef.current;
    ++generationRef.current;
    const id = sessionRef.current;
    sessionRef.current = null;
    clearPdfPixels(canvasRef.current);
    setView({ phase: "idle", pageCount: 0, message: "Document closed." });
    if (client && id) {
      try { await client.close(id); } catch { /* Termination handles worker errors. */ }
    }
  }

  return (
    <main>
      <h1>PDFium engineering check</h1>
      <p>Private local-file verification only. Documents stay in this browser.</p>
      <section aria-label="Local PDF integration harness">
        <label htmlFor="harness-file">Choose local PDF</label>
        <input
          id="harness-file"
          data-testid="harness-file"
          type="file"
          accept=".pdf,application/pdf"
          onChange={openLocalFile}
        />
        <button
          type="button"
          onClick={() => { void closeLocalFile(); }}
          disabled={view.phase === "idle" && !sessionRef.current}
        >
          Close document
        </button>
        <p data-testid="harness-state" role="status" aria-live="polite">
          {view.phase}: {view.message}
        </p>
        {view.phase === "ready" && (
          <p data-testid="harness-pages">Pages: {view.pageCount}</p>
        )}
        <canvas
          ref={canvasRef}
          data-testid="harness-canvas"
          aria-label="First PDF page preview"
          role="img"
          style={{ display: view.phase === "ready" ? "block" : "none", maxWidth: "100%", height: "auto" }}
        />
      </section>
    </main>
  );
}
