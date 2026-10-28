import type { PdfErrorInfo, PdfOpenResult, PdfPixelResult, PdfRenderOptions } from "./types";

export type PdfOperation = "INIT" | "OPEN" | "RENDER" | "CLOSE" | "STATS" | "DISPOSE";

type Envelope = { requestId: number; workerEpoch: string; documentGeneration: number };
export type PdfWorkerRequest = Envelope & (
  | { operation: "INIT"; assetUrl: string }
  | { operation: "OPEN"; bytes: ArrayBuffer }
  | { operation: "RENDER"; sessionId: string; pageIndex: number; options: PdfRenderOptions }
  | { operation: "CLOSE"; sessionId: string }
  | { operation: "STATS" }
  | { operation: "DISPOSE" }
);

export type PdfWorkerStats = { activeDocuments: number; activeAllocations: number };
export type PdfWorkerSuccess =
  | { operation: "INIT" | "CLOSE" | "DISPOSE"; value: null }
  | { operation: "OPEN"; value: PdfOpenResult }
  | { operation: "RENDER"; value: PdfPixelResult }
  | { operation: "STATS"; value: PdfWorkerStats };

export type PdfWorkerResponse = Envelope & (
  | ({ ok: true } & PdfWorkerSuccess)
  | { ok: false; operation: PdfOperation; error: PdfErrorInfo }
);

export const SAFE_KINDS = new Set<PdfErrorInfo["kind"]>([
  "RUNTIME_LOAD", "INVALID_DOCUMENT", "PASSWORD_REQUIRED_OR_INVALID",
  "UNSUPPORTED_SECURITY", "INVALID_PAGE", "LIMIT_EXCEEDED",
  "INVALID_RENDER_OPTIONS", "SESSION_CLOSED", "SESSION_ACTIVE",
  "RENDER_FAILED", "WORKER_FAILED",
]);

export function safeError(error: unknown, fallback: PdfErrorInfo["kind"] = "WORKER_FAILED"): PdfErrorInfo {
  const input = error as Partial<PdfErrorInfo> | null;
  if (input && typeof input.kind === "string" && SAFE_KINDS.has(input.kind)) {
    // Never copy unchecked native diagnostics or exception messages over RPC.
    const nativeCode = typeof input.nativeCode === "number" &&
      Number.isSafeInteger(input.nativeCode) && input.nativeCode >= 0 ? input.nativeCode : undefined;
    return { kind: input.kind, message: publicMessage(input.kind), ...(nativeCode === undefined ? {} : { nativeCode }) };
  }
  return { kind: fallback, message: publicMessage(fallback) };
}

export function publicMessage(kind: PdfErrorInfo["kind"]): string {
  switch (kind) {
    case "RUNTIME_LOAD": return "The PDF engine could not be initialized. Please try again.";
    case "INVALID_DOCUMENT": return "The PDF could not be opened.";
    case "PASSWORD_REQUIRED_OR_INVALID": return "The PDF requires a password.";
    case "UNSUPPORTED_SECURITY": return "This PDF uses unsupported security.";
    case "INVALID_PAGE": return "The requested PDF page is invalid.";
    case "LIMIT_EXCEEDED": return "The PDF exceeds supported resource limits.";
    case "INVALID_RENDER_OPTIONS": return "Unsupported PDF rendering options.";
    case "SESSION_CLOSED": return "The PDF session is closed.";
    case "SESSION_ACTIVE": return "Close the current PDF before opening another.";
    case "RENDER_FAILED": return "The PDF page could not be rendered.";
    default: return "The PDF worker stopped. Please retry with a new session.";
  }
}

export class PdfWorkerError extends Error implements PdfErrorInfo {
  readonly kind: PdfErrorInfo["kind"];
  readonly nativeCode?: number;
  constructor(error: PdfErrorInfo) {
    super(publicMessage(error.kind));
    this.name = "PdfWorkerError";
    this.kind = error.kind;
    this.nativeCode = typeof error.nativeCode === "number" && Number.isSafeInteger(error.nativeCode) && error.nativeCode >= 0
      ? error.nativeCode : undefined;
  }
}
