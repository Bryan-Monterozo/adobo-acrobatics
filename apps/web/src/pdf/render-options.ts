import { PdfDocumentError } from "./errors";
import { PDF_LIMITS, type PdfRenderOptions } from "./types";

export type PdfRenderGeometry = Readonly<{
  /** Integer backing pixels, with devicePixelRatio applied exactly once. */
  width: number;
  height: number;
  /** Logical PDF page size in points, before applying DPR. */
  displayWidth: number;
  displayHeight: number;
  /** Maximum application-owned RGBA output allocation, in bytes. */
  rgbaBytes: number;
}>;

/**
 * Pick a safe browser DPR before constructing PdfRenderOptions.
 * Direct render callers are NOT normalized: invalid options must reject.
 */
export function selectBrowserDpr(devicePixelRatio: unknown): number {
  return typeof devicePixelRatio === "number" && Number.isFinite(devicePixelRatio)
    ? Math.min(PDF_LIMITS.maxDpr, Math.max(PDF_LIMITS.minDpr, devicePixelRatio))
    : PDF_LIMITS.minDpr;
}

/**
 * Pure validation. Call before allocating a bitmap. A PDF page may already be
 * acquired to obtain its logical dimensions; the renderer owns its cleanup.
 */
export function validateRenderGeometry(
  displayWidth: number,
  displayHeight: number,
  options: PdfRenderOptions,
): PdfRenderGeometry {
  if (
    !options ||
    options.scale !== PDF_LIMITS.requiredScale ||
    options.rotation !== PDF_LIMITS.requiredRotation ||
    typeof options.dpr !== "number" ||
    !Number.isFinite(options.dpr) ||
    options.dpr < PDF_LIMITS.minDpr ||
    options.dpr > PDF_LIMITS.maxDpr ||
    typeof displayWidth !== "number" ||
    typeof displayHeight !== "number" ||
    !Number.isFinite(displayWidth) ||
    !Number.isFinite(displayHeight) ||
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    throw new PdfDocumentError("INVALID_RENDER_OPTIONS");
  }

  const scaledWidth = displayWidth * options.dpr;
  const scaledHeight = displayHeight * options.dpr;
  // Finite, positive page geometry too large for finite backing pixels is a
  // resource LIMIT_EXCEEDED, not an invalid option (including overflow).
  if (!Number.isFinite(scaledWidth) || !Number.isFinite(scaledHeight)) {
    throw new PdfDocumentError("LIMIT_EXCEEDED");
  }
  const width = Math.ceil(scaledWidth);
  const height = Math.ceil(scaledHeight);

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 || height < 1 ||
    width > PDF_LIMITS.maxAxisPixels ||
    height > PDF_LIMITS.maxAxisPixels ||
    width * height > PDF_LIMITS.maxPixelArea
  ) {
    throw new PdfDocumentError("LIMIT_EXCEEDED");
  }

  const rgbaBytes = width * height * 4;
  // This follows from the area cap, but guard the eventual allocation contract
  // explicitly before native bitmap creation or owned ArrayBuffer allocation.
  if (!Number.isSafeInteger(rgbaBytes) || rgbaBytes > PDF_LIMITS.maxPixelArea * 4) {
    throw new PdfDocumentError("LIMIT_EXCEEDED");
  }

  return { width, height, displayWidth, displayHeight, rgbaBytes };
}
