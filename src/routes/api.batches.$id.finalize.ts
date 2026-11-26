/**
 * POST /api/batches/:id/finalize — seals a workspace-owned batch against new
 * upload claims while protecting active in-flight upload leases.
 */
import { createFileRoute } from "@tanstack/react-router";
import { finalizeBatchInWorkspace } from "@/lib/server/batches";
import { methodNotAllowedResponse } from "@/lib/server/documents";
import { getServerEnv, HttpError, jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import {
  assertSameOrigin,
  rejectClientWorkspaceId,
  requireWorkspaceContext,
} from "@/lib/server/ownership";
import { getSql, type SqlClient } from "@/lib/server/sql";

async function parseFinalizeOptions(request: Request): Promise<{ allowIncomplete: boolean }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength === "0") return { allowIncomplete: false };

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType) return { allowIncomplete: false };

  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.", "UNSUPPORTED_MEDIA_TYPE");
  }

  const raw = await request.text();
  if (!raw.trim()) return { allowIncomplete: false };
  if (raw.length > 4096) {
    throw new HttpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Malformed JSON request body.", "INVALID_JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Invalid JSON request body.", "INVALID_JSON");
  }
  rejectClientWorkspaceId(parsed);

  const rec = parsed as { allowIncomplete?: unknown };
  if (rec.allowIncomplete !== undefined && typeof rec.allowIncomplete !== "boolean") {
    throw new HttpError(400, "allowIncomplete must be a boolean.", "INVALID_FINALIZE_OPTIONS");
  }
  return { allowIncomplete: Boolean(rec.allowIncomplete) };
}

export async function handleFinalizeBatch(
  request: Request,
  batchId: string,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
    bucketName?: string | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return methodNotAllowedResponse("POST");
    }
    assertSameOrigin(request);
    rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));

    const sql = overrides?.sql ?? getSql(request);
    const { workspace } = await requireWorkspaceContext(sql, request);
    const { allowIncomplete } = await parseFinalizeOptions(request);
    const bucketName = overrides?.bucketName ?? getServerEnv(request).B2_BUCKET_NAME ?? "";

    const result = await finalizeBatchInWorkspace(sql, {
      workspaceId: workspace.id,
      batchId,
      bucketName,
      allowIncomplete,
    });
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("POST");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/batches/$id/finalize POST] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/batches/$id/finalize")({
  server: {
    handlers: {
      POST: async ({ request, params }) => handleFinalizeBatch(request, params.id),
      ANY: () => methodNotAllowedResponse("POST"),
    },
  },
});
