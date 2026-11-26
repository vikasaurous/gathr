/**
 * GET /api/documents/:id/content — authorized, workspace-scoped private PDF
 * content streaming endpoint (never exposes B2 credentials or storage keys).
 */
import { createFileRoute } from "@tanstack/react-router";
import type { B2StorageClient } from "@/lib/server/b2-storage";
import { methodNotAllowedResponse, streamOwnedDocumentContent } from "@/lib/server/documents";
import { HttpError, toSafeErrorResponse } from "@/lib/server/env";
import { getSql, type SqlClient } from "@/lib/server/sql";

export async function handleGetDocumentContent(
  request: Request,
  documentId: string,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
    b2?: B2StorageClient | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "GET") {
      return methodNotAllowedResponse("GET");
    }
    const sql = overrides?.sql ?? getSql(request);
    return await streamOwnedDocumentContent(request, documentId, {
      sql,
      b2: overrides?.b2,
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("GET");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/documents/$id/content GET] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/documents/$id/content")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handleGetDocumentContent(request, params.id),
    },
  },
});
