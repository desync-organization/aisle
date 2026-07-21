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
    // Database and jsdom suites are more reliable on Windows when libsql stays in one worker.
    maxWorkers: 1,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
