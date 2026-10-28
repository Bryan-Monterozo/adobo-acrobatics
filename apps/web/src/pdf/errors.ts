import type { PdfErrorInfo, PdfErrorKind } from "./types";

/** Safe application error. Do not put document content, names or native pointers in messages. */
export class PdfDocumentError extends Error implements PdfErrorInfo {
  constructor(
    readonly kind: PdfErrorKind,
    readonly nativeCode?: number,
  ) {
    super(
      kind === "LIMIT_EXCEEDED"
        ? "The PDF exceeds the supported input limit."
        : kind === "SESSION_ACTIVE"
          ? "Close the current PDF before opening another."
          : kind === "SESSION_CLOSED"
            ? "The PDF session is closed."
            : kind === "PASSWORD_REQUIRED_OR_INVALID"
              ? "The PDF requires a password."
              : kind === "UNSUPPORTED_SECURITY"
                ? "This PDF uses unsupported security."
                : "The PDF could not be opened.",
    );
    this.name = "PdfDocumentError";
  }
}

/**
 * PDFium FPDF_GetLastError() must be called immediately after a failed open,
 * BEFORE any cleanup can change its error state. Only numeric diagnostics
 * are retained; every unknown code safely falls back to INVALID_DOCUMENT.
 */
export function documentOpenError(nativeCode: unknown): PdfDocumentError {
  const code =
    typeof nativeCode === "number" &&
    Number.isSafeInteger(nativeCode) &&
    nativeCode >= 0
      ? nativeCode
      : undefined;

  const kind: PdfErrorKind =
    code === 4
      ? "PASSWORD_REQUIRED_OR_INVALID"
      : code === 5
        ? "UNSUPPORTED_SECURITY"
        : "INVALID_DOCUMENT";

  return new PdfDocumentError(kind, code);
}
