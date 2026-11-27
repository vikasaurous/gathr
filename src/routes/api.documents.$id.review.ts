/**
 * POST /api/documents/:id/review — server-authoritative human review/approval transition.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  BatchCreateValidationError,
  ReviewValidationError,
  validateIdempotencyKey,
  validateReviewDocumentPayload,
} from "@/lib/gathr/ingestion-types";
import {
  methodNotAllowedResponse,
  ReviewStateConflictError,
  transitionDocumentReviewStatus,
} from "@/lib/server/documents";
import {
  HttpError,
  jsonResponse,
  readBoundedJsonBody,
  toSafeErrorResponse,
} from "@/lib/server/env";
import {
  assertSameOrigin,
  rejectClientWorkspaceId,
  requireWorkspaceContext,
} from "@/lib/server/ownership";
import { getSql, type SqlClient } from "@/lib/server/sql";

const MAX_REVIEW_JSON_BYTES = 16 * 1024;

export async function handleReviewDocument(
  request: Request,
  documentId: string,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return methodNotAllowedResponse("POST");
    }

    assertSameOrigin(request);
    rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));

    const sql = overrides?.sql ?? getSql(request);
    const { user, workspace } = await requireWorkspaceContext(sql, request);

    const body = await readBoundedJsonBody(request, MAX_REVIEW_JSON_BYTES);
    rejectClientWorkspaceId(body);

    const rawIdempotencyKey = request.headers.has("idempotency-key")
      ? (request.headers.get("idempotency-key") ?? "")
      : undefined;
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const payload = validateReviewDocumentPayload(body);

    const result = await transitionDocumentReviewStatus(sql, {
      workspaceId: workspace.id,
      documentId,
      actorUserId: user.id,
      reviewStatus: payload.reviewStatus,
      expectedReviewStatus: payload.expectedReviewStatus,
      expectedReviewVersion: payload.expectedReviewVersion,
      idempotencyKey,
    });

    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("POST");
    }
    if (error instanceof BatchCreateValidationError) {
      return jsonResponse({ error: error.message, code: "INVALID_IDEMPOTENCY_KEY" }, 400);
    }
    if (error instanceof ReviewValidationError) {
      return jsonResponse({ error: error.message, code: error.code }, 400);
    }
    if (error instanceof ReviewStateConflictError) {
      return jsonResponse(
        {
          error: error.message,
          code: error.code,
          currentDocument: error.currentDocument,
        },
        409,
      );
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/documents/$id/review POST] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/documents/$id/review")({
  server: {
    handlers: {
      POST: async ({ request, params }) => handleReviewDocument(request, params.id),
      ANY: () => methodNotAllowedResponse("POST"),
    },
  },
});
