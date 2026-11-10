/**
 * Better Auth catch-all API route.
 *
 * Mounts all Better Auth endpoints under /api/auth/* using TanStack Start's
 * file-based server handler API (server.handlers). This is the correct
 * approach for this TanStack Start version — createServerFileRoute does not
 * exist in the installed package.
 *
 * The $ segment catches every sub-path:
 *   /api/auth/sign-up/email
 *   /api/auth/sign-in/email
 *   /api/auth/sign-out
 *   /api/auth/session
 *   etc.
 */
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return auth.handler(request);
      },
      POST: async ({ request }) => {
        return auth.handler(request);
      },
    },
  },
});
