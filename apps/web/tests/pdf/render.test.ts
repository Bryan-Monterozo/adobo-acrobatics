import { describe, expect, it, vi } from "vitest";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { createPdfPageRenderer } from "../../src/pdf/render";
import { PdfDocumentError } from "../../src/pdf/errors";
import type { PdfDocumentOwner } from "../../src/pdf/document";
import type { PdfRenderOptions } from "../../src/pdf/types";

const opts: PdfRenderOptions = { scale: 1, rotation: 0, dpr: 1 };
type Stage = "load" | "page-width" | "create" | "fill" | "render" | "format" | "stride" | "pointer" | "copy";
const rgba = (result: { rgba: ArrayBuffer }) => Array.from(new Uint8Array(result.rgba));

function harness() {
  const log: string[] = [];
  let pages = 2;
  let logicalWidth = 2;
  let logicalHeight = 2;
  let stage: Stage | undefined;
  let format = 4;
  let stride = 12; // BGRA, 2 px with four padding bytes per row.
  let pointer = 256;
  const heap = new Uint8Array(2048);
  const copyPixels = () => {
    // Two rows: red, blue; explicit padding must NOT bleed into output.
    heap.set([0, 0, 255, 255, 0, 0, 255, 255, 99, 99, 99, 99], 256);
    heap.set([255, 0, 0, 255, 255, 0, 0, 255, 88, 88, 88, 88], 268);
  };
  copyPixels();
  const calls = {
    getCount: vi.fn((_doc: number) => { log.push("count"); return pages; }),
    load: vi.fn((_doc: number, _page: number) => {
      log.push("load"); return stage === "load" ? 0 : 300;
    }),
    width: vi.fn((_page: number) => {
      log.push("width");
      if (stage === "page-width") throw new Error("private geometry failure");
      return logicalWidth;
    }),
    height: vi.fn((_page: number) => { log.push("height"); return logicalHeight; }),
    create: vi.fn((_w: number, _h: number, _alpha: number) => {
      log.push("create"); return stage === "create" ? 0 : 400;
    }),
    fill: vi.fn((_bitmap: number, _l: number, _t: number, _w: number, _h: number, _c: number) => {
      log.push("fill"); return stage !== "fill";
    }),
    draw: vi.fn((_bitmap: number, _page: number, _x: number, _y: number,
      _w: number, _h: number, _rot: number, _flags: number) => {
      log.push("draw");
      if (stage === "render") throw new Error("private render failure");
    }),
    getFormat: vi.fn((_bitmap: number) => { log.push("format"); return stage === "format" ? 2 : format; }),
    getStride: vi.fn((_bitmap: number) => { log.push("stride"); return stage === "stride" ? 1 : stride; }),
    getBuffer: vi.fn((_bitmap: number) => { log.push("pointer"); return stage === "pointer" ? 0 : pointer; }),
    destroy: vi.fn((_bitmap: number) => { log.push("destroy"); }),
    close: vi.fn((_page: number) => { log.push("close-page"); }),
  };
  const native = {
    pdfium: {
      get HEAPU8() {
        if (stage !== "copy") return heap;
        return new Proxy(heap, {
          get(target, key) {
            if (key === "258") throw new Error("injected copy failure");
            return Reflect.get(target, key, target);
          },
        });
      },
    },
    FPDF_GetPageCount: calls.getCount,
    FPDF_LoadPage: calls.load,
    FPDF_GetPageWidthF: calls.width,
    FPDF_GetPageHeightF: calls.height,
    FPDFBitmap_Create: calls.create,
    FPDFBitmap_FillRect: calls.fill,
    FPDF_RenderPageBitmap: calls.draw,
    FPDFBitmap_GetFormat: calls.getFormat,
    FPDFBitmap_GetStride: calls.getStride,
    FPDFBitmap_GetBuffer: calls.getBuffer,
    FPDFBitmap_Destroy: calls.destroy,
    FPDF_ClosePage: calls.close,
  } as unknown as WrappedPdfiumModule;
  const documents = { lookup: vi.fn((id: string) => {
    if (id !== "session") throw new PdfDocumentError("SESSION_CLOSED");
    return 100;
  }) } as unknown as PdfDocumentOwner;
  const renderer = createPdfPageRenderer(native, documents);
  return {
    renderer, calls, log, heap, copyPixels,
    setStage: (value: Stage | undefined) => { stage = value; },
    setPages: (value: number) => { pages = value; },
    setSize: (w: number, h: number) => { logicalWidth = w; logicalHeight = h; },
    setFormat: (value: number) => { format = value; },
    setStride: (value: number) => { stride = value; },
    setPointer: (value: number) => { pointer = value; },
  };
}

describe("owned PDFium bitmap rendering", () => {
  it("copies padded BGRA rows to independent RGBA and closes bitmap before page", () => {
    const x = harness();
    const pixels = x.renderer.render("session", 0, opts);
    expect(pixels).toMatchObject({ width: 2, height: 2, displayWidth: 2, displayHeight: 2 });
    expect(rgba(pixels)).toEqual([
      255, 0, 0, 255, 255, 0, 0, 255,
      0, 0, 255, 255, 0, 0, 255, 255,
    ]);
    expect(x.calls.create).toHaveBeenCalledWith(2, 2, 1);
    expect(x.calls.fill).toHaveBeenCalledWith(400, 0, 0, 2, 2, 0xffffffff);
    expect(x.calls.draw).toHaveBeenCalledWith(400, 300, 0, 0, 2, 2, 0, 0);
    expect(x.log.slice(-2)).toEqual(["destroy", "close-page"]);
    x.heap.fill(0, 256, 280); // The output survives native deallocation/reuse.
    expect(rgba(pixels)[0]).toBe(255);
    expect(rgba(pixels)[10]).toBe(255);
  });

  it("uses ceil for backing dimensions at DPR 2", () => {
    const x = harness();
    x.setSize(1.1, 1.1);
    const pixels = x.renderer.render("session", 0, { scale: 1, rotation: 0, dpr: 2 });
    expect([pixels.width, pixels.height]).toEqual([3, 3]);
    expect([pixels.displayWidth, pixels.displayHeight]).toEqual([1.1, 1.1]);
    expect(x.calls.create).toHaveBeenCalledWith(3, 3, 1);
  });

  it.each([-1, 2, 1.5, Infinity, NaN])("rejects invalid page index %s before loading", (index) => {
    const x = harness();
    expect(() => x.renderer.render("session", index, opts)).toThrowError(
      expect.objectContaining({ kind: "INVALID_PAGE" }),
    );
    expect(x.calls.load).not.toHaveBeenCalled();
  });

  it("fails with SESSION_CLOSED before touching native code", () => {
    const x = harness();
    expect(() => x.renderer.render("obsolete", 0, opts)).toThrowError(
      expect.objectContaining({ kind: "SESSION_CLOSED" }),
    );
    expect(x.calls.getCount).not.toHaveBeenCalled();
  });

  it.each([
    { scale: 2, rotation: 0, dpr: 1 },
    { scale: 1, rotation: 90, dpr: 1 },
    { scale: 1, rotation: 0, dpr: NaN },
    { scale: 1, rotation: 0, dpr: Infinity },
    { scale: 1, rotation: 0, dpr: 0.99 },
    { scale: 1, rotation: 0, dpr: 2.01 },
  ])("rejects unsupported options %j and releases page", (bad) => {
    const x = harness();
    expect(() => x.renderer.render("session", 0, bad as PdfRenderOptions)).toThrowError(
      expect.objectContaining({ kind: "INVALID_RENDER_OPTIONS" }),
    );
    expect(x.calls.create).not.toHaveBeenCalled();
    expect(x.log.at(-1)).toBe("close-page");
  });

  it.each([[0, 5], [-2, 5], [NaN, 2], [Infinity, 2]])(
    "rejects invalid logical geometry %s x %s", (w, h) => {
      const x = harness();
      x.setSize(w, h);
      expect(() => x.renderer.render("session", 0, opts)).toThrowError(
        expect.objectContaining({ kind: "INVALID_RENDER_OPTIONS" }),
      );
      expect(x.log.at(-1)).toBe("close-page");
    },
  );

  it.each([[8193, 1], [1, 8193], [8192, 2049]])(
    "rejects over-cap backing size %s x %s before bitmap creation", (w, h) => {
      const x = harness();
      x.setSize(w, h);
      expect(() => x.renderer.render("session", 0, opts)).toThrowError(
        expect.objectContaining({ kind: "LIMIT_EXCEEDED" }),
      );
      expect(x.calls.create).not.toHaveBeenCalled();
      expect(x.log.at(-1)).toBe("close-page");
    },
  );

  it.each(["load", "page-width", "create", "fill", "render", "format", "stride", "pointer", "copy"] as Stage[])(
    "cleans native resources on %s failure", (stage) => {
      const x = harness();
      x.setStage(stage);
      expect(() => x.renderer.render("session", 0, opts)).toThrow();
      const bitmapAcquired = !["load", "page-width", "create"].includes(stage);
      const pageAcquired = stage !== "load";
      expect(x.calls.destroy).toHaveBeenCalledTimes(bitmapAcquired ? 1 : 0);
      expect(x.calls.close).toHaveBeenCalledTimes(pageAcquired ? 1 : 0);
      if (bitmapAcquired) expect(x.log.slice(-2)).toEqual(["destroy", "close-page"]);
      x.setStage(undefined);
      expect(rgba(x.renderer.render("session", 0, opts)).slice(0, 4)).toEqual([255, 0, 0, 255]);
    },
  );

  it("rejects an out-of-heap buffer and releases bitmap/page", () => {
    const x = harness();
    x.setPointer(2045);
    expect(() => x.renderer.render("session", 0, opts)).toThrowError(
      expect.objectContaining({ kind: "RENDER_FAILED" }),
    );
    expect(x.log.slice(-2)).toEqual(["destroy", "close-page"]);
  });

  it("rejects bitmap layout mismatch even if provided buffer is long enough", () => {
    const x = harness();
    x.setFormat(3);
    expect(() => x.renderer.render("session", 0, opts)).toThrowError(
      expect.objectContaining({ kind: "RENDER_FAILED" }),
    );
    expect(x.calls.destroy).toHaveBeenCalledOnce();
  });
});
