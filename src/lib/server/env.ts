import "@tanstack/react-start/server-only";

export interface ServerEnvMap {
  DATABASE_URL?: string | undefined;
  BETTER_AUTH_SECRET?: string | undefined;
  BETTER_AUTH_URL?: string | undefined;
  PRODUCTION_ORIGIN?: string | undefined;
  ADMIN_EMAILS?: string | undefined;
  B2_S3_ENDPOINT?: string | undefined;
  B2_S3_REGION?: string | undefined;
  B2_BUCKET_NAME?: string | undefined;
  B2_APPLICATION_KEY_ID?: string | undefined;
  B2_APPLICATION_KEY?: string | undefined;
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
    B2_S3_ENDPOINT: pick("B2_S3_ENDPOINT"),
    B2_S3_REGION: pick("B2_S3_REGION"),
    B2_BUCKET_NAME: pick("B2_BUCKET_NAME"),
    B2_APPLICATION_KEY_ID: pick("B2_APPLICATION_KEY_ID"),
    B2_APPLICATION_KEY: pick("B2_APPLICATION_KEY"),
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
      "Referrer-Policy": "no-referrer",
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

export async function readBoundedJsonBody(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.", "UNSUPPORTED_MEDIA_TYPE");
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new HttpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
    }
  }

  let rawText = "";
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
      }
      rawText += decoder.decode(value, { stream: true });
    }
    rawText += decoder.decode();
  } else {
    rawText = await request.text();
    if (new TextEncoder().encode(rawText).byteLength > maxBytes) {
      throw new HttpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
    }
  }

  if (!rawText.trim()) {
    throw new HttpError(400, "Request body is required.", "INVALID_JSON");
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new HttpError(400, "Malformed JSON request body.", "INVALID_JSON");
  }
}
