/**
 * GET /api/documents/:id — server-side document metadata retrieval scoped to the
 * authenticated user's workspace and owning batch (never exposes storage keys or credentials).
 * DELETE /api/documents/:id — atomically persists cleanup obligations and deletes
 * an unfinalized document record while recomputing its parent batch status.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  deleteDocumentInWorkspace,
  getWorkspaceDocumentDetail,
  methodNotAllowedResponse,
} from "@/lib/server/documents";
import { getServerEnv, HttpError, jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import {
  assertSameOrigin,
  rejectClientWorkspaceId,
  requireWorkspaceContext,
} from "@/lib/server/ownership";
import { getSql, type SqlClient } from "@/lib/server/sql";

export async function handleGetDocumentDetail(
  request: Request,
  documentId: string,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "GET") {
      return methodNotAllowedResponse("GET, DELETE");
    }
    rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));
    const sql = overrides?.sql ?? getSql(request);
    const { workspace } = await requireWorkspaceContext(sql, request);
    const detail = await getWorkspaceDocumentDetail(sql, workspace.id, documentId);
    return jsonResponse(detail, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("GET, DELETE");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/documents/$id GET] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export async function handleDeleteDocument(
  request: Request,
  documentId: string,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
    bucketName?: string | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "DELETE") {
      return methodNotAllowedResponse("GET, DELETE");
    }
    assertSameOrigin(request);
    rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));

    const sql = overrides?.sql ?? getSql(request);
    const { workspace } = await requireWorkspaceContext(sql, request);
    const bucketName = overrides?.bucketName ?? getServerEnv(request).B2_BUCKET_NAME ?? "";

    const result = await deleteDocumentInWorkspace(sql, {
      workspaceId: workspace.id,
      documentId,
      bucketName,
    });
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("GET, DELETE");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/documents/$id DELETE] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/documents/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handleGetDocumentDetail(request, params.id),
      DELETE: async ({ request, params }) => handleDeleteDocument(request, params.id),
      ANY: () => methodNotAllowedResponse("GET, DELETE"),
    },
  },
});
