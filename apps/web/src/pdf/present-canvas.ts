import type { PdfPixelResult } from "./types";

/**
 * Only owned RGBA from the worker reaches this canvas. Verify dimensions and
 * byte length before creating ImageData; never read the WASM heap here.
 */
export function presentPdfPixels(
  canvas: HTMLCanvasElement,
  image: PdfPixelResult,
): void {
  const { width, height, rgba } = image;
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 ||
    !(rgba instanceof ArrayBuffer) ||
    rgba.byteLength !== width * height * 4
  ) {
    throw new Error("The PDF page could not be displayed.");
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The PDF page could not be displayed.");
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(rgba), width, height),
    0,
    0,
  );
}

/** Clear old pixels immediately on replacement, close, or failed load. */
export function clearPdfPixels(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}
