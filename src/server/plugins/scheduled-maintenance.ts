import "@tanstack/react-start/server-only";
import { definePlugin } from "nitro";
import { useNitroHooks } from "nitro/app";
import { runScheduledMaintenance } from "../../lib/server/maintenance";

export default definePlugin(() => {
  const hooks = useNitroHooks();
  hooks.hook("cloudflare:scheduled", async ({ controller, env }) => {
    try {
      await runScheduledMaintenance({
        env: (env as Record<string, unknown> | undefined) ?? undefined,
        cron: controller?.cron,
      });
    } catch (error) {
      console.error("[gathr:scheduled] maintenance failed:", error);
    }
  });
});
