import "@tanstack/react-start/server-only";
import { neon } from "@neondatabase/serverless";
import { HttpError, getServerEnv } from "./env";

/** Minimal SQL client interface (matches neon().query) so callers are unit-testable. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

const TRANSIENT_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

function extractCauseCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && TRANSIENT_CONNECT_CODES.has(direct)) return direct;
  const source = (error as { sourceError?: unknown }).sourceError;
  if (source) {
    const nested = extractCauseCode(source);
    if (nested) return nested;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause ? extractCauseCode(cause) : undefined;
}

export function isTransientConnectError(error: unknown): boolean {
  return extractCauseCode(error) !== undefined;
}

/**
 * Creates a stateless Neon HTTP client for the current request. Nothing is
 * cached at module scope, which is safe on Cloudflare Workers where I/O objects
 * cannot be shared across requests. Fails clearly when the database is not
 * configured instead of falling back to anything.
 */
export function getSql(request?: Request, directEnv?: Record<string, unknown>): SqlClient {
  const url = getServerEnv(request, directEnv).DATABASE_URL;
  if (!url) {
    throw new HttpError(503, "Database is not configured.", "DB_NOT_CONFIGURED");
  }
  const sql = neon(url);
  return {
    query: async (text, params) => {
      try {
        return (await sql.query(text, params ?? [])) as Record<string, unknown>[];
      } catch (error) {
        if (!isTransientConnectError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return (await sql.query(text, params ?? [])) as Record<string, unknown>[];
      }
    },
  };
}
