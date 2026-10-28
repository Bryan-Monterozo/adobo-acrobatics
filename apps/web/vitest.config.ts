import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/pdf/**/*.test.ts"],
    exclude: ["tests/browser/**", "**/node_modules/**", "**/.next/**"],
    environment: "node",
    globals: false,
    isolate: true,
  },
});
