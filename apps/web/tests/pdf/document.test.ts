import { describe, expect, it, vi } from "vitest";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { createPdfDocumentOwner, PdfDocumentError } from "../../src/pdf/document";
import { PDF_LIMITS } from "../../src/pdf/types";

function setup() {
  const log: string[] = [];
  const heap = new Uint8Array(100_000);
  let allocated = 0;
  let opened = 0;
  let pageCount = 2;
  let nativeError = 3;
  const malloc = vi.fn((size: number) => {
    log.push("malloc:" + size);
    allocated = 128;
    return allocated;
  });
  const free = vi.fn((ptr: number) => { log.push("free:" + ptr); });
  const load = vi.fn((ptr: number, len: number, password: string) => {
    log.push("load:" + ptr + ":" + len + ":" + password);
    return opened;
  });
  const closeDocument = vi.fn((handle: number) => { log.push("close:" + handle); });
  const count = vi.fn((handle: number) => { log.push("count:" + handle); return pageCount; });
  const lastError = vi.fn(() => { log.push("error"); return nativeError; });
  const module = {
    pdfium: { wasmExports: { malloc, free }, HEAPU8: heap },
    FPDF_LoadMemDocument: load,
    FPDF_CloseDocument: closeDocument,
    FPDF_GetPageCount: count,
    FPDF_GetLastError: lastError,
  } as unknown as WrappedPdfiumModule;

  return {
    owner: createPdfDocumentOwner(module), log, heap, malloc, free,
    load, count, closeDocument, lastError,
    setOpened: (value: number) => { opened = value; },
    setPageCount: (value: number) => { pageCount = value; },
    setError: (value: number) => { nativeError = value; },
  };
}
const valid = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 52]);

describe("document ownership", () => {
  it("copies bytes into owned WASM memory and keeps allocation through document lifetime", () => {
    const x = setup();
    x.setOpened(500);
    const original = valid.slice();
    const opened = x.owner.open(valid);
    expect(opened.pageCount).toBe(2);
    expect(opened.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(x.heap.slice(128, 128 + valid.length)).toEqual(original);
    expect(valid).toEqual(original); // No detachment or mutation.
    expect(x.load).toHaveBeenCalledWith(128, valid.length, "");
    expect(x.count).toHaveBeenCalledWith(500);
    expect(x.owner.lookup(opened.sessionId)).toBe(500);
    expect(x.owner.stats()).toEqual({ activeDocuments: 1, activeAllocations: 1 });
    expect(x.free).not.toHaveBeenCalled();
    x.owner.close(opened.sessionId);
    expect(x.log.indexOf("close:500")).toBeLessThan(x.log.indexOf("free:128"));
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
    x.owner.close(opened.sessionId);
    expect(x.closeDocument).toHaveBeenCalledTimes(1);
    expect(x.free).toHaveBeenCalledTimes(1);
    expect(() => x.owner.lookup(opened.sessionId)).toThrowError(PdfDocumentError);
    expect(() => x.owner.lookup(opened.sessionId)).toThrowError(
      expect.objectContaining({ kind: "SESSION_CLOSED" }),
    );
  });

  it("rejects overlapping sessions without allocating more memory", () => {
    const x = setup();
    x.setOpened(10);
    const first = x.owner.open(valid);
    expect(() => x.owner.open(valid)).toThrowError(
      expect.objectContaining({ kind: "SESSION_ACTIVE" }),
    );
    expect(x.malloc).toHaveBeenCalledTimes(1);
    expect(() => x.owner.close("invalid")).toThrowError(
      expect.objectContaining({ kind: "SESSION_CLOSED" }),
    );
    x.owner.close(first.sessionId);
    const next = x.owner.open(valid);
    expect(next.sessionId).not.toBe(first.sessionId);
    x.owner.close(next.sessionId);
  });

  it("rejects empty and oversized inputs before native allocation", () => {
    const x = setup();
    expect(() => x.owner.open(new Uint8Array())).toThrowError(
      expect.objectContaining({ kind: "INVALID_DOCUMENT" }),
    );
    expect(() => x.owner.open(new Uint8Array(PDF_LIMITS.maxInputBytes + 1))).toThrowError(
      expect.objectContaining({ kind: "LIMIT_EXCEEDED" }),
    );
    expect(x.malloc).not.toHaveBeenCalled();
  });

  it("handles native allocation failure", () => {
    const x = setup();
    x.malloc.mockReturnValueOnce(0);
    expect(() => x.owner.open(valid)).toThrowError(
      expect.objectContaining({ kind: "LIMIT_EXCEEDED" }),
    );
    expect(x.free).not.toHaveBeenCalled();
  });

  it("releases the allocation on native document-open failure, after reading error", () => {
    const x = setup();
    x.setError(4);
    expect(() => x.owner.open(valid)).toThrowError(
      expect.objectContaining({ kind: "PASSWORD_REQUIRED_OR_INVALID", nativeCode: 4 }),
    );
    expect(x.log).toEqual([
      "malloc:8", "load:128:8:", "error", "free:128",
    ]);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
    x.setOpened(250);
    const next = x.owner.open(valid);
    expect(next.pageCount).toBe(2);
    x.owner.close(next.sessionId);
  });

  it("maps unsupported security and other PDFium open errors", () => {
    const x = setup();
    x.setError(5);
    expect(() => x.owner.open(valid)).toThrowError(
      expect.objectContaining({ kind: "UNSUPPORTED_SECURITY", nativeCode: 5 }),
    );
    x.setError(3);
    expect(() => x.owner.open(valid)).toThrowError(
      expect.objectContaining({ kind: "INVALID_DOCUMENT", nativeCode: 3 }),
    );
    expect(x.free).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, Number.NaN])("closes acquired native handle if page count is %s", (pages) => {
    const x = setup();
    x.setOpened(700);
    x.setPageCount(pages);
    expect(() => x.owner.open(valid)).toThrowError(
      expect.objectContaining({ kind: "INVALID_DOCUMENT" }),
    );
    expect(x.log).toEqual([
      "malloc:8", "load:128:8:", "count:700", "close:700", "free:128",
    ]);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
  });

  it("releases allocated bytes even if native close itself throws", () => {
    const x = setup();
    x.setOpened(900);
    const session = x.owner.open(valid);
    x.closeDocument.mockImplementationOnce(() => { throw new Error("native close failed"); });
    expect(() => x.owner.close(session.sessionId)).toThrow("native close failed");
    expect(x.free).toHaveBeenCalledTimes(1);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
    x.owner.close(session.sessionId);
  });

  it("frees allocated memory if native load throws unexpectedly", () => {
    const x = setup();
    x.load.mockImplementationOnce(() => { throw new Error("native failure"); });
    expect(() => x.owner.open(valid)).toThrow("native failure");
    expect(x.free).toHaveBeenCalledTimes(1);
  });

  it("closes the native document and frees input when page-count lookup throws", () => {
    const x = setup();
    x.setOpened(321);
    x.count.mockImplementationOnce(() => { throw new Error("count failure"); });
    expect(() => x.owner.open(valid)).toThrow("count failure");
    expect(x.log).toEqual([
      "malloc:8", "load:128:8:", "close:321", "free:128",
    ]);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
  });

  it("frees malloc output when the active heap is unexpectedly too small", () => {
    const x = setup();
    x.malloc.mockReturnValueOnce(99_998);
    expect(() => x.owner.open(valid)).toThrowError(
      expect.objectContaining({ kind: "LIMIT_EXCEEDED" }),
    );
    expect(x.load).not.toHaveBeenCalled();
    expect(x.free).toHaveBeenCalledOnce();
    expect(x.free).toHaveBeenCalledWith(99_998);
  });
});
