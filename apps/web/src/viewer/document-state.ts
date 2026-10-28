import type { PdfErrorKind } from "../pdf/types";
import { publicMessage } from "../pdf/protocol";

/** React stores only display state. Native handles and source bytes stay out. */
export type DocumentState =
  | { phase: "empty"; message: string }
  | { phase: "opening"; message: string }
  | { phase: "rendering" | "ready"; message: string; pageCount: number; pageNumber: number }
  | { phase: "error"; message: string; kind: PdfErrorKind };

export const emptyDocument: DocumentState = {
  phase: "empty", message: "Choose a PDF from your device to preview its first page.",
};
export const openingDocument = (): DocumentState =>
  ({ phase: "opening", message: "Opening your PDF…" });
export const renderingDocument = (pageCount: number, pageNumber = 1): DocumentState =>
  ({ phase: "rendering", pageCount, pageNumber,
    message: `Rendering page ${pageNumber}…` });
export const readyDocument = (pageCount: number, pageNumber = 1): DocumentState =>
  ({ phase: "ready", pageCount, pageNumber,
    message: `Page ${pageNumber} of ${pageCount} ready.` });

export function failedDocument(error: unknown): DocumentState {
  const candidate = error as { kind?: unknown } | null;
  const allowed: readonly PdfErrorKind[] = [
    "RUNTIME_LOAD", "INVALID_DOCUMENT", "PASSWORD_REQUIRED_OR_INVALID",
    "UNSUPPORTED_SECURITY", "INVALID_PAGE", "LIMIT_EXCEEDED",
    "INVALID_RENDER_OPTIONS", "SESSION_CLOSED", "SESSION_ACTIVE",
    "RENDER_FAILED", "WORKER_FAILED",
  ];
  const kind = typeof candidate?.kind === "string" &&
    allowed.includes(candidate.kind as PdfErrorKind)
    ? candidate.kind as PdfErrorKind : "WORKER_FAILED";
  return { phase: "error", kind, message: publicMessage(kind) };
}
