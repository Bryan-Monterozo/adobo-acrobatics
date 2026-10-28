import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { PDF_LIMITS, type PdfErrorInfo } from "./types";

export class PdfRuntimeLoadError extends Error implements PdfErrorInfo {
  readonly kind = "RUNTIME_LOAD" as const;

  constructor() {
    super("The PDF engine could not be initialized. Please try again.");
    this.name = "PdfRuntimeLoadError";
  }
}

export interface PdfRuntimeDependencies {
  origin: () => string;
  fetchWasm: (url: string, options: RequestInit) => Promise<Response>;
  initModule: (options: { wasmBinary: ArrayBuffer }) => Promise<WrappedPdfiumModule>;
}

export interface PdfRuntime {
  ensureReady(): Promise<void>;
  /** Internal adapter access only; native functions never cross the worker boundary. */
  getModule(): Promise<WrappedPdfiumModule>;
}

const WASM_MAGIC = [0, 97, 115, 109, 1, 0, 0, 0];

function validateAssetUrl(value: string, origin: string): string {
  const url = new URL(value);
  const expectedOrigin = new URL(origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["http:", "https:"].includes(expectedOrigin.protocol) ||
    url.origin !== expectedOrigin.origin ||
    value !== url.href ||
    Boolean(url.username || url.password || url.search || url.hash) ||
    !url.pathname.endsWith("/pdfium/2.15.1/pdfium.wasm")
  ) {
    throw new PdfRuntimeLoadError();
  }
  return url.href;
}

function validWasmHeader(bytes: Uint8Array): boolean {
  return bytes.length >= WASM_MAGIC.length &&
    WASM_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * One owner per native runtime. Create inside a browser/worker lifecycle;
 * imports have no network or native startup side effects.
 */
export function createPdfRuntime(
  assetUrl: string,
  overrides: Partial<PdfRuntimeDependencies> = {},
): PdfRuntime {
  const dependencies: PdfRuntimeDependencies = {
    origin: overrides.origin ?? (() => globalThis.location.origin),
    fetchWasm: overrides.fetchWasm ?? ((url, options) => fetch(url, options)),
    initModule: overrides.initModule ?? ((options) => init(options)),
  };

  let readyModule: WrappedPdfiumModule | undefined;
  let pending: Promise<void> | undefined;

  function ensureReady(): Promise<void> {
    if (readyModule) return Promise.resolve();
    if (pending) return pending;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const startup = (async () => {
      const url = validateAssetUrl(assetUrl, dependencies.origin());
      const response = await dependencies.fetchWasm(url, {
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (controller.signal.aborted || !response.ok) throw new PdfRuntimeLoadError();

      const wasmBinary = await response.arrayBuffer();
      if (controller.signal.aborted || !validWasmHeader(new Uint8Array(wasmBinary))) {
        throw new PdfRuntimeLoadError();
      }

      const module = await dependencies.initModule({ wasmBinary });
      if (controller.signal.aborted || typeof module?.PDFiumExt_Init !== "function") {
        throw new PdfRuntimeLoadError();
      }
      module.PDFiumExt_Init();
      if (controller.signal.aborted) throw new PdfRuntimeLoadError();
      readyModule = module;
    })();

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PdfRuntimeLoadError());
      }, PDF_LIMITS.initializationTimeoutMs);
    });

    const attempt: Promise<void> = Promise.race([startup, deadline])
      .catch(() => {
        readyModule = undefined;
        throw new PdfRuntimeLoadError();
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        if (pending === attempt) pending = undefined;
      });
    pending = attempt;
    return attempt;
  }

  async function getModule(): Promise<WrappedPdfiumModule> {
    await ensureReady();
    if (!readyModule) throw new PdfRuntimeLoadError();
    return readyModule;
  }

  return { ensureReady, getModule };
}
