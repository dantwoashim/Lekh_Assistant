import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["src/tests/setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/release/**",
      "**/native/**/.build/**",
      "**/native/daemon/dist/**"
    ],
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
    coverage: {
      provider: "v8"
    }
  }
});
