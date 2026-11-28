/**
 * POST /api/exports — workspace-scoped, read-only export endpoint for CSV, XLSX, PDF, and ZIP.
 */
import { createFileRoute } from "@tanstack/react-router";
import type { B2StorageClient } from "@/lib/server/b2-storage";
import { methodNotAllowedResponse } from "@/lib/server/documents";
import { HttpError, readBoundedJsonBody, toSafeErrorResponse } from "@/lib/server/env";
import { exportWorkspaceDocuments } from "@/lib/server/exports";
import { getSql, type SqlClient } from "@/lib/server/sql";

const MAX_EXPORT_REQUEST_JSON_BYTES = 256 * 1024;

export async function handlePostExport(
  request: Request,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
    b2?: B2StorageClient | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return methodNotAllowedResponse("POST");
    }
    const body = await readBoundedJsonBody(request, MAX_EXPORT_REQUEST_JSON_BYTES);
    const sql = overrides?.sql ?? getSql(request);
    return await exportWorkspaceDocuments(request, body, {
      sql,
      b2: overrides?.b2,
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("POST");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/exports POST] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/exports")({
  server: {
    handlers: {
      POST: async ({ request }) => handlePostExport(request),
      ANY: () => methodNotAllowedResponse("POST"),
    },
  },
});
