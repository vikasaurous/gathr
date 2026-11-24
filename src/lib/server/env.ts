import "@tanstack/react-start/server-only";

export interface ServerEnvMap {
  DATABASE_URL?: string | undefined;
  BETTER_AUTH_SECRET?: string | undefined;
  BETTER_AUTH_URL?: string | undefined;
  PRODUCTION_ORIGIN?: string | undefined;
  ADMIN_EMAILS?: string | undefined;
}

type RequestWithCloudflareRuntime = Request & {
  runtime?: {
    cloudflare?: {
      env?: Record<string, unknown>;
    };
  };
};

function readStringEnv(
  source: Record<string, unknown> | undefined,
  key: keyof ServerEnvMap,
): string | undefined {
  if (!source) return undefined;
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolves server environment variables inside request/handler execution.
 * Never caches credentials or connection strings at module scope.
 */
export function getServerEnv(request?: Request, directEnv?: Record<string, unknown>): ServerEnvMap {
  const cfEnv = (request as RequestWithCloudflareRuntime | undefined)?.runtime?.cloudflare?.env;
  const globalEnv = (globalThis as { __env__?: Record<string, unknown> }).__env__;
  const procEnv =
    typeof process !== "undefined" && process.env
      ? (process.env as Record<string, unknown>)
      : undefined;

  const pick = (key: keyof ServerEnvMap) =>
    readStringEnv(directEnv, key) ??
    readStringEnv(cfEnv, key) ??
    readStringEnv(globalEnv, key) ??
    readStringEnv(procEnv, key);

  return {
    DATABASE_URL: pick("DATABASE_URL"),
    BETTER_AUTH_SECRET: pick("BETTER_AUTH_SECRET"),
    BETTER_AUTH_URL: pick("BETTER_AUTH_URL"),
    PRODUCTION_ORIGIN: pick("PRODUCTION_ORIGIN"),
    ADMIN_EMAILS: pick("ADMIN_EMAILS"),
  };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function toSafeErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      error.code ? { error: error.message, code: error.code } : { error: error.message },
      error.status,
    );
  }
  return jsonResponse({ error: "An unexpected server error occurred." }, 500);
}
