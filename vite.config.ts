// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// Never set ssr.external or resolve.external: the Worker has no runtime module resolution, so
// the build fails. Never add compression (compressPublicAssets, vite-plugin-compression):
// hosting already compresses at the edge.
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import dns from "node:dns";
import path from "node:path";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

// Prefer IPv4 in local Node dev/build to avoid 10s IPv6 blackhole connect timeouts
// against Neon / Backblaze B2 on networks without working IPv6 routing.
dns.setDefaultResultOrder("ipv4first");

export const SCHEDULED_MAINTENANCE_CRON = "*/5 * * * *";

interface NitroModuleSetupContext {
  options: {
    plugins?: string[];
    alias?: Record<string, string>;
    cloudflare?: {
      wrangler?: Record<string, unknown>;
    };
  };
}

const scheduledMaintenanceNitroPlugin: Plugin & {
  nitro: {
    name: string;
    setup: (nitro: NitroModuleSetupContext) => void;
  };
} = {
  name: "gathr:scheduled-maintenance",
  nitro: {
    name: "gathr:scheduled-maintenance",
    setup(nitro) {
      nitro.options.alias = {
        ...nitro.options.alias,
        "@": path.resolve(process.cwd(), "src").replace(/\\/g, "/"),
      };
      nitro.options.plugins = [
        ...(nitro.options.plugins ?? []),
        path
          .resolve(process.cwd(), "src/server/plugins/scheduled-maintenance.ts")
          .replace(/\\/g, "/"),
      ];
      nitro.options.cloudflare = {
        ...nitro.options.cloudflare,
        wrangler: {
          ...nitro.options.cloudflare?.wrangler,
          triggers: {
            crons: [SCHEDULED_MAINTENANCE_CRON],
          },
        },
      };
    },
  },
};

export default defineConfig({
  plugins: [scheduledMaintenanceNitroPlugin],
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
