import { describe, expect, it } from "vitest";
import { selectBrowserDpr, validateRenderGeometry } from "../../src/pdf/render-options";
import { PDF_LIMITS, type PdfRenderOptions } from "../../src/pdf/types";

const opt = (dpr: number): PdfRenderOptions => ({ scale: 1, rotation: 0, dpr });
const err = (action: () => unknown, kind: string) =>
  expect(action).toThrowError(expect.objectContaining({ kind }));

describe("E06 deterministic PDF backing geometry", () => {
  it.each([
    { dpr: 1, width: 200, height: 300, bytes: 240_000 },
    { dpr: 2, width: 400, height: 600, bytes: 960_000 },
    { dpr: 1.25, width: 250, height: 375, bytes: 375_000 },
    { dpr: 1.5, width: 300, height: 450, bytes: 540_000 },
  ])("accepts fixture at DPR $dpr without changing logical dimensions", (v) => {
    expect(validateRenderGeometry(200, 300, opt(v.dpr))).toEqual({
      width: v.width, height: v.height,
      displayWidth: 200, displayHeight: 300,
      rgbaBytes: v.bytes,
    });
  });

  it("rounds each backing dimension up just once", () => {
    expect(validateRenderGeometry(200.1, 300.1, opt(2))).toEqual({
      width: 401, height: 601,
      displayWidth: 200.1, displayHeight: 300.1,
      rgbaBytes: 401 * 601 * 4,
    });
  });

  it.each([
    [8_192, 2_048, 67_108_864],
    [2_048, 8_192, 67_108_864],
    [4_096, 4_096, 67_108_864],
    [8_192, 1, 32_768],
    [1, 8_192, 32_768],
  ])("accepts safe axis and area boundary %s × %s", (w, h, bytes) => {
    const result = validateRenderGeometry(w, h, opt(1));
    expect(result).toMatchObject({ width: w, height: h, rgbaBytes: bytes });
    expect(result.rgbaBytes).toBeLessThanOrEqual(PDF_LIMITS.maxPixelArea * 4);
  });

  it("accepts DPR 2 exactly on the allowed area boundary", () => {
    expect(validateRenderGeometry(4_096, 1_024, opt(2))).toMatchObject({
      width: 8_192, height: 2_048, rgbaBytes: 67_108_864,
      displayWidth: 4_096, displayHeight: 1_024,
    });
  });

  it.each([
    [8_193, 1],
    [1, 8_193],
    [8_192, 2_049],
    [4_097, 4_096],
    [8_192.000001, 1],
    [Number.MAX_VALUE, Number.MAX_VALUE],
    [1e308, 1],
  ])("rejects positive out-of-limit geometry %s × %s", (w, h) => {
    err(() => validateRenderGeometry(w, h, opt(1)), "LIMIT_EXCEEDED");
  });

  it("treats multiplication overflow from finite positive geometry as a resource limit", () => {
    err(
      () => validateRenderGeometry(Number.MAX_VALUE, 1, opt(2)),
      "LIMIT_EXCEEDED",
    );
  });

  it.each([
    [0, 1],
    [-1, 1],
    [1, 0],
    [1, -1],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
    [100, Number.NEGATIVE_INFINITY],
    [Number.MIN_VALUE, Number.NaN],
  ])("rejects invalid logical geometry %s × %s", (w, h) => {
    err(() => validateRenderGeometry(w, h, opt(1)), "INVALID_RENDER_OPTIONS");
  });

  it.each([
    { scale: 0, rotation: 0, dpr: 1 },
    { scale: 2, rotation: 0, dpr: 1 },
    { scale: 1, rotation: 90, dpr: 1 },
    { scale: 1, rotation: -90, dpr: 1 },
    { scale: 1, rotation: 0, dpr: 0 },
    { scale: 1, rotation: 0, dpr: 0.99999 },
    { scale: 1, rotation: 0, dpr: 2.00001 },
    { scale: 1, rotation: 0, dpr: NaN },
    { scale: 1, rotation: 0, dpr: Infinity },
    { scale: 1, rotation: 0, dpr: -Infinity },
    { scale: 1, rotation: 0, dpr: undefined },
    { scale: 1, rotation: 0, dpr: "2" },
  ])("rejects unsupported API render options %j", (value) => {
    err(() => validateRenderGeometry(200, 300, value as PdfRenderOptions), "INVALID_RENDER_OPTIONS");
  });

  it("rejects missing render options instead of accidentally using defaults", () => {
    err(() => validateRenderGeometry(200, 300, undefined as unknown as PdfRenderOptions), "INVALID_RENDER_OPTIONS");
  });

  it.each([
    [undefined, 1],
    [Number.NaN, 1],
    [Infinity, 1],
    [-Infinity, 1],
    [null, 1],
    ["2", 1],
    [0, 1],
    [0.8, 1],
    [1.75, 1.75],
    [2, 2],
    [3, 2],
  ])("clamps a browser-reported DPR %s to %s", (raw, expected) => {
    expect(selectBrowserDpr(raw)).toBe(expected);
  });

  it("never allocates a bitmap in the pure geometry helper", () => {
    // The helper operates on numbers only, allowing exact 64 MiB boundary
    // tests without allocating browser or WASM bitmap memory.
    const result = validateRenderGeometry(8_192, 2_048, opt(1));
    expect(Object.keys(result).sort()).toEqual(
      ["width", "height", "displayWidth", "displayHeight", "rgbaBytes"].sort(),
    );
  });
});
