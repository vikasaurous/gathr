/**
 * GET /api/batches/:id — recovers a workspace-owned persisted batch and its
 * individual document intake records.
 * DELETE /api/batches/:id — atomically persists cleanup obligations and removes
 * the workspace-owned batch and document metadata.
 */
import { createFileRoute } from "@tanstack/react-router";
import { deleteBatchInWorkspace, getWorkspaceBatchDetail } from "@/lib/server/batches";
import { methodNotAllowedResponse } from "@/lib/server/documents";
import { getServerEnv, HttpError, jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import {
  assertSameOrigin,
  rejectClientWorkspaceId,
  requireWorkspaceContext,
} from "@/lib/server/ownership";
import { getSql, type SqlClient } from "@/lib/server/sql";

export async function handleGetBatchDetail(request: Request, batchId: string): Promise<Response> {
  try {
    if (request.method !== "GET") {
      return methodNotAllowedResponse("GET, DELETE");
    }
    rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));
    const sql = getSql(request);
    const { workspace } = await requireWorkspaceContext(sql, request);
    const detail = await getWorkspaceBatchDetail(sql, workspace.id, batchId);
    return jsonResponse(detail);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/batches/$id GET] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export async function handleDeleteBatch(
  request: Request,
  batchId: string,
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

    const result = await deleteBatchInWorkspace(sql, {
      workspaceId: workspace.id,
      batchId,
      bucketName,
    });
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("GET, DELETE");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/batches/$id DELETE] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/batches/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handleGetBatchDetail(request, params.id),
      DELETE: async ({ request, params }) => handleDeleteBatch(request, params.id),
      ANY: () => methodNotAllowedResponse("GET, DELETE"),
    },
  },
});
