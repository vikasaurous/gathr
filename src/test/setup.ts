import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { uploadOrchestrator } from "@/lib/gathr/upload-orchestrator";

// Browser-only stubs. Test files that run in the node environment
// (`// @vitest-environment node`, e.g. the database schema tests) have no window.
if (typeof window !== "undefined") {
  afterEach(() => {
    uploadOrchestrator.reset();
  });

  Object.defineProperty(window, "scrollTo", {
    writable: true,
    value: () => {},
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
