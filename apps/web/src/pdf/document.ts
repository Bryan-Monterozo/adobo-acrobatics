import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { PDF_LIMITS, type PdfOpenResult } from "./types";
import { PdfDocumentError, documentOpenError } from "./errors";

// Preserve the existing document module's public error import for E03 callers.
export { PdfDocumentError } from "./errors";

export type DocumentStats = Readonly<{
  activeDocuments: number;
  activeAllocations: number;
}>;

type ActiveDocument = { sessionId: string; pointer: number; handle: number };

/**
 * One synchronous native owner. Call only from a serialized worker/engineering
 * harness; callers outside this module never receive a native pointer.
 */
export function createPdfDocumentOwner(module: WrappedPdfiumModule) {
  let current: ActiveDocument | undefined;

  function stats(): DocumentStats {
    return {
      activeDocuments: current ? 1 : 0,
      activeAllocations: current ? 1 : 0,
    };
  }

  function lookup(sessionId: string): number {
    if (!current || current.sessionId !== sessionId) {
      throw new PdfDocumentError("SESSION_CLOSED");
    }
    return current.handle; // Native adapter internal use only.
  }

  function close(sessionId: string): void {
    if (!current || current.sessionId !== sessionId) {
      if (!current) return; // Idempotent closed session.
      throw new PdfDocumentError("SESSION_CLOSED");
    }
    const owned = current;
    current = undefined; // Invalidate before releasing native ownership.
    try {
      module.FPDF_CloseDocument(owned.handle);
    } finally {
      module.pdfium.wasmExports.free(owned.pointer);
    }
  }

  function open(bytes: Uint8Array): PdfOpenResult {
    if (current) throw new PdfDocumentError("SESSION_ACTIVE");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new PdfDocumentError("INVALID_DOCUMENT");
    }
    if (bytes.byteLength > PDF_LIMITS.maxInputBytes) {
      throw new PdfDocumentError("LIMIT_EXCEEDED");
    }

    const length = bytes.byteLength;
    const pointer = module.pdfium.wasmExports.malloc(length);
    if (!Number.isSafeInteger(pointer) || pointer <= 0) {
      throw new PdfDocumentError("LIMIT_EXCEEDED");
    }

    let handle = 0;
    try {
      // A fresh heap view is mandatory after malloc, which may grow WASM memory.
      const heap = module.pdfium.HEAPU8;
      if (!heap || pointer + length > heap.byteLength) {
        throw new PdfDocumentError("LIMIT_EXCEEDED");
      }
      heap.set(bytes, pointer); // Preserve the caller's view and native backing bytes.
      handle = module.FPDF_LoadMemDocument(pointer, length, "");
      if (!Number.isSafeInteger(handle) || handle <= 0) {
        // Read native error immediately, before cleanup calls change its state.
        const code = module.FPDF_GetLastError();
        throw documentOpenError(code);
      }
      const pageCount = module.FPDF_GetPageCount(handle);
      if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
        throw new PdfDocumentError("INVALID_DOCUMENT");
      }
      const sessionId = crypto.randomUUID();
      current = { sessionId, pointer, handle };
      return { sessionId, pageCount };
    } catch (error) {
      try {
        if (handle > 0) module.FPDF_CloseDocument(handle);
      } finally {
        module.pdfium.wasmExports.free(pointer);
      }
      throw error;
    }
  }

  return { open, close, lookup, stats };
}

export type PdfDocumentOwner = ReturnType<typeof createPdfDocumentOwner>;
