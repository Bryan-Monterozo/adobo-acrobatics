// Deterministic, public fixtures for adapter and browser tests. Never use user PDFs.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import PDFDocument from "pdfkit";
import { createCanvas, DOMMatrix, ImageData } from "@napi-rs/canvas";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const defaultDir = "apps/web/tests/fixtures/pdf";
const fixedDate = "2020-01-01T00:00:00.000Z";
const size = [200, 300];
const rect = [20, 20, 80, 80];
const sample = [40, 40];
const passwords = { user: "adobo-fixture", owner: "adobo-owner-fixture" };
const names = ["valid-two-page.pdf", "protected-two-page.pdf", "empty.pdf", "corrupt.pdf"];

function options() {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  if (args.filter((arg) => arg === "--verify").length > 1) throw new Error("Duplicate --verify");
  const index = args.indexOf("--out-dir");
  if (index !== -1 && (index + 1 >= args.length || args[index + 1].startsWith("--"))) {
    throw new Error("--out-dir needs a repository-relative directory");
  }
  const unknown = args.filter((value, i) => value !== "--verify" && value !== "--out-dir" && i !== index + 1);
  if (unknown.length) throw new Error("Unknown argument: " + unknown.join(", "));
  const rel = index < 0 ? defaultDir : args[index + 1];
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((v) => v === ".." || v === "." || v === "")) {
    throw new Error("Output directory must be a safe repository-relative path");
  }
  const dir = path.resolve(root, rel);
  if (!dir.startsWith(root + path.sep)) throw new Error("Output directory escapes repository");
  return { verify, dir };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function pdfBytes(protectedDocument) {
  const document = new PDFDocument({
    pdfVersion: "1.4",
    autoFirstPage: false,
    size,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    compress: false,
    info: {
      Title: "Adobo Acrobatics fixture",
      Author: "Adobo Acrobatics",
      Subject: "Deterministic PDF viewer test",
      Keywords: "local fixture",
      Creator: "Adobo Acrobatics E00",
      Producer: "PDFKit 0.17.2",
      CreationDate: new Date(fixedDate),
      ModDate: new Date(fixedDate),
    },
    ...(protectedDocument ? {
      userPassword: passwords.user,
      ownerPassword: passwords.owner,
      permissions: { printing: "highResolution", modifying: false, copying: false },
    } : {}),
  });
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    document.on("data", (part) => chunks.push(part));
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  for (const color of ["#ff0000", "#0000ff"]) {
    document.addPage({ size, margins: 0 });
    document.rect(0, 0, size[0], size[1]).fill("#ffffff");
    document.rect(...rect).fill(color);
  }
  document.end();
  return finished;
}

function expectedManifest(buffers) {
  const details = {
    "valid-two-page.pdf": { outcome: "OPEN_OK", pages: 2 },
    "protected-two-page.pdf": { outcome: "PASSWORD_REQUIRED_OR_INVALID", pagesWithPassword: 2 },
    "empty.pdf": { outcome: "INVALID_DOCUMENT" },
    "corrupt.pdf": { outcome: "INVALID_DOCUMENT" },
  };
  const files = Object.fromEntries(names.map((name) => [
    name, { ...details[name], bytes: buffers[name].byteLength, sha256: sha256(buffers[name]) },
  ]));
  return {
    schema: 1,
    generator: "scripts/generate-pdf-fixtures.mjs",
    packages: { pdfkit: "0.17.2", "pdfjs-dist": "5.4.296", "@napi-rs/canvas": "0.1.80" },
    parameters: {
      pdfVersion: "1.4",
      compression: false,
      fonts: false,
      metadata: { creationDate: fixedDate, modificationDate: fixedDate },
      pageSizePoints: { width: size[0], height: size[1] },
      pageCount: 2,
      background: [255, 255, 255, 255],
      marker: {
        rectanglePoints: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] },
        sampleAtDpr1: { x: sample[0], y: sample[1] },
        sampleAtDpr2: { x: 80, y: 80 },
        page1Rgba: [255, 0, 0, 255],
        page2Rgba: [0, 0, 255, 255],
      },
      protected: { standardSecurity: "PDF 1.4", userPassword: passwords.user, ownerPassword: passwords.owner },
      maxInputBytes: 26_214_400,
      maxAxisPixels: 8192,
      maxPixelArea: 16_777_216,
    },
    fixtures: files,
  };
}

function same(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(what + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

async function validatePdfJs(buffers) {
  // Register the local Node canvas primitives before importing independent PDF.js.
  globalThis.DOMMatrix ??= DOMMatrix;
  globalThis.ImageData ??= ImageData;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const open = async (name, password) => {
    const task = pdfjs.getDocument({
      data: Uint8Array.from(buffers[name]),
      ...(password === undefined ? {} : { password }),
      useSystemFonts: false,
      disableFontFace: true,
      isEvalSupported: false,
    });
    try {
      const pdf = await task.promise;
      same(pdf.numPages, 2, name + " page count");
      const { info } = await pdf.getMetadata();
      same(info.PDFFormatVersion, "1.4", name + " PDF version");
      same(info.CreationDate, "D:20200101000000Z", name + " CreationDate");
      same(info.ModDate, "D:20200101000000Z", name + " ModDate");
      for (let index = 1; index <= 2; index++) {
        const page = await pdf.getPage(index);
        for (const dpr of [1, 2]) {
          const viewport = page.getViewport({ scale: dpr });
          const expectedSize = size.map((dimension) => dimension * dpr);
          same([viewport.width, viewport.height], expectedSize, name + " DPR " + dpr + " dimensions");
          const canvas = createCanvas(expectedSize[0], expectedSize[1]);
          const ctx = canvas.getContext("2d");
          await page.render({ canvasContext: ctx, canvas, viewport }).promise;
          const rgba = Array.from(ctx.getImageData(sample[0] * dpr, sample[1] * dpr, 1, 1).data);
          same(rgba, index === 1 ? [255, 0, 0, 255] : [0, 0, 255, 255], name + " page " + index + " DPR " + dpr + " marker");
        }
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
  };

  const rejectsPassword = async (password, expectedCode) => {
    const task = pdfjs.getDocument({
      data: Uint8Array.from(buffers["protected-two-page.pdf"]),
      ...(password === undefined ? {} : { password }),
    });
    try {
      await task.promise;
      throw new Error("Protected PDF unexpectedly opened with " + (password === undefined ? "no password" : "incorrect password"));
    } catch (error) {
      if (error?.name !== "PasswordException" || error.code !== expectedCode) {
        throw error;
      }
    } finally {
      await task.destroy();
    }
  };

  const rejectsInvalid = async (name) => {
    const task = pdfjs.getDocument({ data: Uint8Array.from(buffers[name]) });
    try {
      await task.promise;
      throw new Error(name + " unexpectedly opened");
    } catch (error) {
      if (!["InvalidPDFException", "MissingPDFException"].includes(error?.name)) throw error;
    } finally {
      await task.destroy();
    }
  };

  await open("valid-two-page.pdf");
  await rejectsPassword(undefined, 1); // PDF.js NEED_PASSWORD
  await rejectsPassword("not-the-password", 2); // PDF.js INCORRECT_PASSWORD
  await open("protected-two-page.pdf", passwords.user);
  await rejectsInvalid("empty.pdf");
  await rejectsInvalid("corrupt.pdf");
}

async function main() {
  const { verify, dir } = options();
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const [name, version] of Object.entries({
    pdfkit: "0.17.2", "pdfjs-dist": "5.4.296", "@napi-rs/canvas": "0.1.80",
  })) {
    if (packageJson.devDependencies[name] !== version) throw new Error(name + " version changed; review fixture contract");
  }

  const buffers = {
    "valid-two-page.pdf": await pdfBytes(false),
    "protected-two-page.pdf": await pdfBytes(true),
    "empty.pdf": Buffer.alloc(0),
    "corrupt.pdf": Buffer.from("Adobo Acrobatics fixed corrupt PDF fixture; deliberately not a PDF.\n", "ascii"),
  };
  const manifest = expectedManifest(buffers);
  const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";

  // Verify the independent reader and colored output, not just a writer/hash round-trip.
  await validatePdfJs(buffers);

  if (verify) {
    for (const name of names) {
      const disk = await readFile(path.join(dir, name));
      if (!disk.equals(buffers[name])) throw new Error(name + " differs from deterministic generation");
    }
    const diskManifest = await readFile(path.join(dir, "manifest.json"), "utf8");
    if (diskManifest !== manifestBytes) throw new Error("manifest.json differs from deterministic generation");
    console.log("Verified: 4 fixture bytes/hashes, manifest, dimensions, red/blue pixels, password failures/success and corrupt rejection");
    return;
  }

  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(path.join(dir, name), buffers[name]);
  await writeFile(path.join(dir, "manifest.json"), manifestBytes);
  console.log("Generated and independently checked 4 PDF fixtures in " + path.relative(root, dir));
  for (const name of names) console.log(name + " " + buffers[name].length + " bytes SHA256 " + sha256(buffers[name]));
}
main().catch((error) => { console.error("Fixture verification failed:", error); process.exitCode = 1; });
