/**
 * Shared application-facing PDF contract. Native handles and pointers must stay
 * inside the PDFium adapter/worker; these values are safe at the UI boundary.
 */
export const PDF_LIMITS = {
  maxInputBytes: 26_214_400,
  maxAxisPixels: 8_192,
  maxPixelArea: 16_777_216,
  requiredScale: 1,
  requiredRotation: 0,
  minDpr: 1,
  maxDpr: 2,
  initializationTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
} as const;

export type PdfErrorKind =
  | "RUNTIME_LOAD"
  | "INVALID_DOCUMENT"
  | "PASSWORD_REQUIRED_OR_INVALID"
  | "UNSUPPORTED_SECURITY"
  | "INVALID_PAGE"
  | "LIMIT_EXCEEDED"
  | "INVALID_RENDER_OPTIONS"
  | "SESSION_CLOSED"
  | "SESSION_ACTIVE"
  | "RENDER_FAILED"
  | "WORKER_FAILED";

export type PdfErrorInfo = {
  kind: PdfErrorKind;
  message: string;
  /** Native numeric error code only; never include input bytes or a filename. */
  nativeCode?: number;
};

export type PdfRenderOptions = {
  scale: 1;
  rotation: 0;
  dpr: number;
};

export type PdfOpenResult = {
  sessionId: string;
  pageCount: number;
};

export type PdfPixelResult = {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  /** Owned row-major RGBA buffer, independent of WASM heap lifetime. */
  rgba: ArrayBuffer;
};

export type PdfAdapter = {
  ensureReady(): Promise<void>;
  open(bytes: Uint8Array): Promise<PdfOpenResult>;
  render(
    sessionId: string,
    pageIndex: number,
    options: PdfRenderOptions,
  ): Promise<PdfPixelResult>;
  close(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
};
