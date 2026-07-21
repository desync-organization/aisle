import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    // Database and jsdom suites can exhaust Windows fork workers at CPU-count defaults.
    maxWorkers: 2,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
