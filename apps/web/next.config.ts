import { createRequire } from "node:module";
import path from "node:path";
import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

if (!/^(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) {
  throw new Error(
    "NEXT_PUBLIC_BASE_PATH must be empty or a path such as /adobo-test, without a trailing slash.",
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  cacheComponents: false,
  basePath,
  webpack(config, { isServer }) {
    if (!isServer) {
      const requireFromApp = createRequire(new URL("./package.json", import.meta.url));
      const wasmFile = requireFromApp.resolve("@embedpdf/pdfium/pdfium.wasm");
      const browserLoader = path.join(path.dirname(wasmFile), "index.browser.js");
      config.resolve ??= {};
      config.resolve.alias = {
        ...config.resolve.alias,
        "@embedpdf/pdfium$": browserLoader,
      };
    }
    return config;
  },
};

export default nextConfig;
