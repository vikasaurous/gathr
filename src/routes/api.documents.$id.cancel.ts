/**
 * POST /api/documents/:id/cancel — cancels an active upload attempt on the
 * server so cancelled browser uploads release active leases and record failure.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isUuid } from "@/lib/gathr/ingestion-types";
import { type B2StorageClient } from "@/lib/server/b2-storage";
import { cancelDocumentUploadAttempt, methodNotAllowedResponse } from "@/lib/server/documents";
import { getServerEnv, HttpError, jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import {
  assertSameOrigin,
  rejectClientWorkspaceId,
  requireWorkspaceContext,
} from "@/lib/server/ownership";
import { getSql, type SqlClient } from "@/lib/server/sql";

async function parseOptionalAttemptId(request: Request): Promise<string | undefined> {
  const contentLength = request.headers.get("content-length");
  if (contentLength === "0") return undefined;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType) return undefined;

  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.", "UNSUPPORTED_MEDIA_TYPE");
  }

  const raw = await request.text();
  if (!raw.trim()) return undefined;
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
  if (rec.attemptId === undefined) return undefined;
  if (typeof rec.attemptId !== "string" || !isUuid(rec.attemptId)) {
    throw new HttpError(400, "Invalid attempt identifier.", "INVALID_ATTEMPT");
  }
  return rec.attemptId;
}

export async function handleCancelDocumentUpload(
  request: Request,
  documentId: string,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
    b2?: B2StorageClient | undefined;
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
    const attemptId = await parseOptionalAttemptId(request);
    const bucketName =
      overrides?.b2?.bucketName ?? getServerEnv(request).B2_BUCKET_NAME ?? "unconfigured";

    const result = await cancelDocumentUploadAttempt(sql, {
      workspaceId: workspace.id,
      documentId,
      bucketName,
      attemptId,
    });
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("POST");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/documents/$id/cancel POST] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/documents/$id/cancel")({
  server: {
    handlers: {
      POST: async ({ request, params }) => handleCancelDocumentUpload(request, params.id),
      ANY: () => methodNotAllowedResponse("POST"),
    },
  },
});
