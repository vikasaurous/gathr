/**
 * GET /api/batches/:id — recovers a workspace-owned persisted batch and its
 * individual document intake records.
 */
import { createFileRoute } from "@tanstack/react-router";
import { getWorkspaceBatchDetail } from "@/lib/server/batches";
import { jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import { rejectClientWorkspaceId, requireWorkspaceContext } from "@/lib/server/ownership";
import { getSql } from "@/lib/server/sql";

export async function handleGetBatchDetail(request: Request, batchId: string): Promise<Response> {
  try {
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

export const Route = createFileRoute("/api/batches/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handleGetBatchDetail(request, params.id),
    },
  },
});
