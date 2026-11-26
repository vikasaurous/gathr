import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth, type Session } from "@/lib/auth/server";
import { resolveSession } from "@/lib/server/auth-session";

/**
 * Minimal session shape exposed to client routes and SSR hydration context.
 * Excludes raw session tokens, IP addresses, and user-agent metadata.
 */
export interface ClientSession {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
}

export function toClientSession(session: Session | null | undefined): ClientSession | null {
  if (!session) return null;
  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image ?? null,
    },
    session: {
      id: session.session.id,
      userId: session.session.userId,
      expiresAt: session.session.expiresAt,
    },
  };
}

/**
 * Server function to retrieve the authenticated Better Auth session.
 *
 * Runs on the server during SSR (direct execution with incoming request headers)
 * and via RPC from the browser (fetch request carrying session cookies).
 */
export const getSessionFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ClientSession | null> => {
    try {
      return toClientSession(await resolveSession());
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
      const session = await resolveSession();
      if (!session) return [];
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
