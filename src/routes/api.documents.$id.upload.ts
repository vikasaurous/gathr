/**
 * PUT /api/documents/:id/upload — server-owned streaming PDF ingestion endpoint
 * for one document attempt at a time.
 */
import { createFileRoute } from "@tanstack/react-router";
import type { B2StorageClient } from "@/lib/server/b2-storage";
import { methodNotAllowedResponse, uploadDocumentStream } from "@/lib/server/documents";
import { HttpError, jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import { getSql, type SqlClient } from "@/lib/server/sql";

/**
 * Marks early-rejected upload responses as `Connection: close` so HTTP/1.1
 * clients do not reuse a socket with an unread request body stream.
 */
function closeConnectionOnError(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Connection", "close");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleUploadDocument(
  request: Request,
  documentId: string,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
    b2?: B2StorageClient | undefined;
    leaseSeconds?: number | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "PUT") {
      return closeConnectionOnError(methodNotAllowedResponse("PUT"));
    }
    const sql = overrides?.sql ?? getSql(request);
    const result = await uploadDocumentStream(request, documentId, {
      sql,
      b2: overrides?.b2,
      leaseSeconds: overrides?.leaseSeconds,
    });
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return closeConnectionOnError(methodNotAllowedResponse("PUT"));
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/documents/$id/upload PUT] unexpected error:", error);
    }
    return closeConnectionOnError(toSafeErrorResponse(error));
  }
}

export const Route = createFileRoute("/api/documents/$id/upload")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => handleUploadDocument(request, params.id),
    },
  },
});
