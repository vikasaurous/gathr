import "@tanstack/react-start/server-only";
import { neon } from "@neondatabase/serverless";
import { HttpError, getServerEnv } from "./env";

/** Minimal SQL client interface (matches neon().query) so callers are unit-testable. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Creates a stateless Neon HTTP client for the current request. Nothing is
 * cached at module scope, which is safe on Cloudflare Workers where I/O objects
 * cannot be shared across requests. Fails clearly when the database is not
 * configured instead of falling back to anything.
 */
export function getSql(request?: Request): SqlClient {
  const url = getServerEnv(request).DATABASE_URL;
  if (!url) {
    throw new HttpError(503, "Database is not configured.", "DB_NOT_CONFIGURED");
  }
  const sql = neon(url);
  return {
    query: (text, params) => sql.query(text, params ?? []) as Promise<Record<string, unknown>[]>,
  };
}
