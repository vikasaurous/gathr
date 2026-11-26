/**
 * POST /api/documents/:id/heartbeat — renews the active upload lease for a
 * specific attemptId while keeping expired or superseded attempts fenced.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isUuid } from "@/lib/gathr/ingestion-types";
import { heartbeatDocumentUploadAttempt, methodNotAllowedResponse } from "@/lib/server/documents";
import { HttpError, jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import {
  assertSameOrigin,
  rejectClientWorkspaceId,
  requireWorkspaceContext,
} from "@/lib/server/ownership";
import { getSql, type SqlClient } from "@/lib/server/sql";

async function parseHeartbeatPayload(request: Request): Promise<{ attemptId: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.", "UNSUPPORTED_MEDIA_TYPE");
  }

  const raw = await request.text();
  if (!raw.trim()) {
    throw new HttpError(400, "Request body is required.", "INVALID_JSON");
  }
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

  const rec = parsed as { attemptId?: unknown };
  if (typeof rec.attemptId !== "string" || !isUuid(rec.attemptId)) {
    throw new HttpError(400, "Valid attemptId is required.", "INVALID_ATTEMPT");
  }
  return { attemptId: rec.attemptId };
}

export async function handleHeartbeatDocumentUpload(
  request: Request,
  documentId: string,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
    leaseSeconds?: number | undefined;
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
    const { attemptId } = await parseHeartbeatPayload(request);

    const result = await heartbeatDocumentUploadAttempt(sql, {
      workspaceId: workspace.id,
      documentId,
      attemptId,
      leaseSeconds: overrides?.leaseSeconds,
    });
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("POST");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/documents/$id/heartbeat POST] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/documents/$id/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request, params }) => handleHeartbeatDocumentUpload(request, params.id),
      ANY: () => methodNotAllowedResponse("POST"),
    },
  },
});
