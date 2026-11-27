import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 15_000,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Phase 3–5 test files — excluded on main until their feature branches are merged
    exclude: ["src/test/document-ingestion.test.ts", "src/test/document-ingestion-ui.test.tsx"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
