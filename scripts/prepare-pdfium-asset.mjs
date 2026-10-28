import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2.15.1";
const EXPECTED_SIZE = 4_646_932;
const EXPECTED_SHA256 = "5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa";
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

// Anchor resolution to the owning app, not npm's current hoisting layout.
const appManifestPath = fileURLToPath(new URL("../apps/web/package.json", import.meta.url));
const fromApp = createRequire(appManifestPath);
const appRoot = path.dirname(appManifestPath);
const destination = path.join(appRoot, "public", "pdfium", VERSION, "pdfium.wasm");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertWasm(bytes, source) {
  if (
    bytes.length !== EXPECTED_SIZE ||
    !bytes.subarray(0, WASM_HEADER.length).equals(WASM_HEADER) ||
    digest(bytes) !== EXPECTED_SHA256
  ) {
    throw new Error(
      `${source}: mismatched PDFium WASM. Expected @embedpdf/pdfium@${VERSION}, ${EXPECTED_SIZE} bytes, SHA-256 ${EXPECTED_SHA256}. Reinstall the exact locked dependency.`,
    );
  }
}

async function main() {
  const fromPackage = fromApp.resolve("@embedpdf/pdfium/pdfium.wasm");
  const distDirectory = path.dirname(fromPackage);
  const packageDirectory = path.dirname(distDirectory);
  const metadata = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  if (metadata.name !== "@embedpdf/pdfium" || metadata.version !== VERSION) {
    throw new Error(`Expected @embedpdf/pdfium@${VERSION}, got ${metadata.name}@${metadata.version}`);
  }
  if (metadata.exports?.["./pdfium.wasm"] !== "./dist/pdfium.wasm") {
    throw new Error("Installed PDFium WASM export differs from pinned package contract.");
  }
  const browserLoader = path.join(distDirectory, "index.browser.js");
  const browserInfo = await stat(browserLoader);
  if (!browserInfo.isFile() || browserInfo.size === 0) {
    throw new Error("Pinned PDFium browser loader is missing or empty.");
  }

  const original = await readFile(fromPackage);
  assertWasm(original, "Installed source");

  try {
    const existing = await readFile(destination);
    if (existing.equals(original)) {
      console.log(`PDFium ${VERSION} verified: matching local WASM already exists (${EXPECTED_SHA256}).`);
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + `.tmp-${process.pid}`;
  try {
    await copyFile(fromPackage, temporary);
    const copied = await readFile(temporary);
    assertWasm(copied, "Copied asset");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  const verified = await readFile(destination);
  assertWasm(verified, "Published asset");
  console.log(`PDFium ${VERSION} prepared: ${path.relative(appRoot, destination)} (${EXPECTED_SIZE} bytes; SHA-256 ${EXPECTED_SHA256}).`);
}

main().catch((error) => {
  console.error("PDFium asset preparation failed:", error.message);
  process.exitCode = 1;
});
