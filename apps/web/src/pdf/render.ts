import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { PdfDocumentOwner } from "./document";
import { PdfDocumentError } from "./errors";
import { type PdfPixelResult, type PdfRenderOptions } from "./types";
import { validateRenderGeometry } from "./render-options";

// Pinned PDFium bitmap constants: FPDFBitmap_Create(alpha=1) yields BGRA (4).
// Keep the native BGRA/stride representation inside the adapter boundary.
const FPDF_BITMAP_BGRA = 4;
const BYTES_PER_PIXEL = 4;

/**
 * Render exactly one page. Native page and bitmap never escape this call.
 * Own a copy of row-major RGBA pixels before releasing either native handle.
 * The owner is synchronous/serialized today; the future worker will own it.
 */
export function createPdfPageRenderer(
  module: WrappedPdfiumModule,
  documents: PdfDocumentOwner,
) {
  function render(
    sessionId: string,
    pageIndex: number,
    options: PdfRenderOptions,
  ): PdfPixelResult {
    const documentHandle = documents.lookup(sessionId);
    const pageCount = module.FPDF_GetPageCount(documentHandle);
    if (
      !Number.isSafeInteger(pageIndex) ||
      pageIndex < 0 ||
      !Number.isSafeInteger(pageCount) ||
      pageIndex >= pageCount
    ) {
      throw new PdfDocumentError("INVALID_PAGE");
    }
    const page = module.FPDF_LoadPage(documentHandle, pageIndex);
    if (!Number.isSafeInteger(page) || page <= 0) {
      throw new PdfDocumentError("RENDER_FAILED");
    }

    try {
      const logicalWidth = module.FPDF_GetPageWidthF(page);
      const logicalHeight = module.FPDF_GetPageHeightF(page);
      const { width, height, rgbaBytes } = validateRenderGeometry(logicalWidth, logicalHeight, options);
      const bitmap = module.FPDFBitmap_Create(width, height, 1);
      if (!Number.isSafeInteger(bitmap) || bitmap <= 0) {
        throw new PdfDocumentError("LIMIT_EXCEEDED");
      }

      try {
        if (!module.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)) {
          throw new PdfDocumentError("RENDER_FAILED");
        }
        // Draw over a white opaque background; rotation 0 / flags 0.
        module.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0);
        const format = module.FPDFBitmap_GetFormat(bitmap);
        const stride = module.FPDFBitmap_GetStride(bitmap);
        const pointer = module.FPDFBitmap_GetBuffer(bitmap);
        const minStride = width * BYTES_PER_PIXEL;
        // Re-acquire the heap only after all native calls (WASM memory may grow).
        const heap = module.pdfium.HEAPU8;
        const lastByteExclusive = pointer + (height - 1) * stride + minStride;
        if (
          format !== FPDF_BITMAP_BGRA ||
          !Number.isSafeInteger(stride) ||
          stride < minStride ||
          !Number.isSafeInteger(pointer) ||
          pointer <= 0 ||
          !heap ||
          !Number.isSafeInteger(lastByteExclusive) ||
          lastByteExclusive > heap.byteLength
        ) {
          throw new PdfDocumentError("RENDER_FAILED");
        }

        const owned = new Uint8Array(rgbaBytes);
        for (let y = 0; y < height; y++) {
          const row = pointer + y * stride;
          const destination = y * minStride;
          for (let x = 0; x < minStride; x += BYTES_PER_PIXEL) {
            const src = row + x;
            const dst = destination + x;
            owned[dst] = heap[src + 2]; // R
            owned[dst + 1] = heap[src + 1]; // G
            owned[dst + 2] = heap[src]; // B
            owned[dst + 3] = heap[src + 3]; // A
          }
        }
        return {
          width, height,
          displayWidth: logicalWidth,
          displayHeight: logicalHeight,
          rgba: owned.buffer,
        };
      } finally {
        module.FPDFBitmap_Destroy(bitmap);
      }
    } finally {
      module.FPDF_ClosePage(page);
    }
  }

  return { render };
}

export type PdfPageRenderer = ReturnType<typeof createPdfPageRenderer>;
