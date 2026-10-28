import { describe, expect, it, vi } from "vitest";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { PDF_LIMITS } from "../../src/pdf/types";
import { createPdfDocumentOwner, PdfDocumentError } from "../../src/pdf/document";
import { documentOpenError } from "../../src/pdf/errors";

function fixture() {
  const actions: string[] = [];
  const heap = new Uint8Array(16_384);
  let failCode = 3;
  let shouldOpen = false;
  let nextHandle = 100;
  const malloc = vi.fn((_length: number) => { actions.push("alloc"); return 256; });
  const free = vi.fn((_ptr: number) => { actions.push("free"); });
  const load = vi.fn((_pointer: number, _size: number, password: string) => {
    expect(password).toBe("");
    actions.push("load");
    return shouldOpen ? nextHandle++ : 0;
  });
  const getError = vi.fn(() => { actions.push("error"); return failCode; });
  const getPages = vi.fn((_handle: number) => { actions.push("pages"); return 2; });
  const closeNative = vi.fn((_handle: number) => { actions.push("close"); });
  const native = {
    pdfium: { wasmExports: { malloc, free }, HEAPU8: heap },
    FPDF_LoadMemDocument: load,
    FPDF_GetLastError: getError,
    FPDF_GetPageCount: getPages,
    FPDF_CloseDocument: closeNative,
  } as unknown as WrappedPdfiumModule;
  return {
    owner: createPdfDocumentOwner(native), actions, malloc, free, load,
    getError, getPages, closeNative,
    fail(code: number) { failCode = code; shouldOpen = false; },
    succeed() { shouldOpen = true; },
  };
}

const valid = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 52]);

describe("PDFium open-error normalization", () => {
  it.each([
    [0, "INVALID_DOCUMENT"],
    [1, "INVALID_DOCUMENT"],
    [2, "INVALID_DOCUMENT"],
    [3, "INVALID_DOCUMENT"],
    [4, "PASSWORD_REQUIRED_OR_INVALID"],
    [5, "UNSUPPORTED_SECURITY"],
    [6, "INVALID_DOCUMENT"],
    [7, "INVALID_DOCUMENT"],
    [8, "INVALID_DOCUMENT"],
    [99, "INVALID_DOCUMENT"],
  ] as const)("maps native code %s to %s and supports next valid open", (code, kind) => {
    const x = fixture();
    x.fail(code);
    let error: unknown;
    try { x.owner.open(valid); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(PdfDocumentError);
    expect(error).toMatchObject({ kind, nativeCode: code });
    expect((error as Error).message).not.toContain("99");
    expect(x.actions).toEqual(["alloc", "load", "error", "free"]);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
    x.succeed();
    const session = x.owner.open(valid);
    expect(session.pageCount).toBe(2);
    expect(x.owner.stats()).toEqual({ activeDocuments: 1, activeAllocations: 1 });
    x.owner.close(session.sessionId);
    expect(x.actions.slice(-2)).toEqual(["close", "free"]);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
    expect(x.free).toHaveBeenCalledTimes(2);
  });

  it.each([NaN, Infinity, -1, 1.2, undefined, "secret"] as unknown[])(
    "ignores invalid native diagnostics instead of leaking them: %s",
    (value) => {
      const error = documentOpenError(value);
      expect(error).toMatchObject({ kind: "INVALID_DOCUMENT", nativeCode: undefined });
      expect(error.message).toBe("The PDF could not be opened.");
    },
  );

  it("empty and over-limit inputs never reach malloc, and valid input still works", () => {
    const x = fixture();
    x.succeed();
    expect(() => x.owner.open(new Uint8Array())).toThrowError(
      expect.objectContaining({ kind: "INVALID_DOCUMENT" }),
    );
    expect(() => x.owner.open(new Uint8Array(PDF_LIMITS.maxInputBytes + 1))).toThrowError(
      expect.objectContaining({ kind: "LIMIT_EXCEEDED" }),
    );
    expect(x.malloc).not.toHaveBeenCalled();
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
    const session = x.owner.open(valid);
    expect(session.pageCount).toBe(2);
    x.owner.close(session.sessionId);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
  });

  it("does not turn invalid page-count failure into a stale session", () => {
    const x = fixture();
    x.succeed();
    x.getPages.mockImplementationOnce(() => { x.actions.push("pages"); return 0; });
    expect(() => x.owner.open(valid)).toThrowError(
      expect.objectContaining({ kind: "INVALID_DOCUMENT" }),
    );
    expect(x.actions).toEqual(["alloc", "load", "pages", "close", "free"]);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
    const session = x.owner.open(valid);
    x.owner.close(session.sessionId);
    expect(x.owner.stats()).toEqual({ activeDocuments: 0, activeAllocations: 0 });
  });
});
