import "@tanstack/react-start/server-only";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth, type Session } from "@/lib/auth/server";

/**
 * The ONLY place in the app that asks Better Auth for the current session.
 * Server functions, SSR and API routes all resolve identity through this
 * function (directly or via requireSession / getOptionalSession), so there is
 * a single authoritative session mechanism.
 *
 * Pass the incoming Request from API route handlers; server functions can omit
 * it and the current request headers are used.
 */
export async function resolveSession(request?: Request): Promise<Session | null> {
  const headers = request ? request.headers : getRequestHeaders();
  return auth.api.getSession({ headers });
}
