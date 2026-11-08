import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth, type Session } from "@/lib/auth/server";

/**
 * Server function to retrieve the authenticated Better Auth session.
 *
 * Runs on the server during SSR (direct execution with incoming request headers)
 * and via RPC from the browser (fetch request carrying session cookies).
 */
export const getSessionFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<Session | null> => {
    try {
      const headers = getRequestHeaders();
      const session = await auth.api.getSession({ headers });
      return session ?? null;
    } catch (err) {
      console.error("[getSessionFn] Failed to get session:", err);
      return null;
    }
  },
);

export interface LinkedAccountSummary {
  id: string;
  providerId: string;
  createdAt?: string | Date;
}

/**
 * Server function to list all accounts/providers linked to the authenticated user.
 */
export const listAccountsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<LinkedAccountSummary[]> => {
    try {
      const headers = getRequestHeaders();
      const accounts = await auth.api.listUserAccounts({ headers });
      if (!accounts || !Array.isArray(accounts)) return [];
      return accounts.map((acc) => ({
        id: acc.id,
        providerId: acc.providerId,
        createdAt: acc.createdAt,
      }));
    } catch (err) {
      console.error("[listAccountsFn] Failed to list accounts:", err);
      return [];
    }
  },
);
