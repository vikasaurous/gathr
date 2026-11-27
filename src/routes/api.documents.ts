/**
 * GET /api/documents — workspace-scoped document & review queue listing.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  isDocumentReviewStatus,
  isUuid,
  stripControlChars,
  type DocumentUploadStatus,
  type EffectiveDocumentReviewState,
} from "@/lib/gathr/ingestion-types";
import { listWorkspaceDocuments, methodNotAllowedResponse } from "@/lib/server/documents";
import { HttpError, jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import { rejectClientWorkspaceId, requireWorkspaceContext } from "@/lib/server/ownership";
import { getSql, type SqlClient } from "@/lib/server/sql";

const VALID_UPLOAD_STATUSES = new Set<DocumentUploadStatus>([
  "pending_upload",
  "uploading",
  "uploaded",
  "failed",
]);

function parseDocumentListOptions(url: URL) {
  const statusRaw = url.searchParams.get("status");
  let status: DocumentUploadStatus | undefined;
  if (statusRaw !== null && statusRaw !== "") {
    if (!VALID_UPLOAD_STATUSES.has(statusRaw as DocumentUploadStatus)) {
      throw new HttpError(400, "Invalid document upload status filter.", "INVALID_DOCUMENT_STATUS");
    }
    status = statusRaw as DocumentUploadStatus;
  }

  const reviewRaw = url.searchParams.get("reviewStatus");
  let reviewStatus: EffectiveDocumentReviewState | undefined;
  if (reviewRaw !== null && reviewRaw !== "") {
    if (reviewRaw === "unreviewed") {
      reviewStatus = "unreviewed";
    } else if (isDocumentReviewStatus(reviewRaw)) {
      reviewStatus = reviewRaw;
    } else {
      throw new HttpError(400, "Invalid review status filter.", "INVALID_REVIEW_STATUS");
    }
  }

  const batchIdRaw = url.searchParams.get("batchId");
  let batchId: string | undefined;
  if (batchIdRaw !== null && batchIdRaw !== "") {
    if (!isUuid(batchIdRaw)) {
      throw new HttpError(400, "Invalid batch identifier filter.", "INVALID_BATCH_ID");
    }
    batchId = batchIdRaw;
  }

  const limitRaw = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d+$/.test(limitRaw)) {
      throw new HttpError(400, "Invalid pagination limit.", "INVALID_PAGINATION");
    }
    const parsed = Number(limitRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
      throw new HttpError(400, "Pagination limit must be between 1 and 200.", "INVALID_PAGINATION");
    }
    limit = parsed;
  }

  const offsetRaw = url.searchParams.get("offset");
  let offset: number | undefined;
  if (offsetRaw !== null && offsetRaw !== "") {
    if (!/^\d+$/.test(offsetRaw)) {
      throw new HttpError(400, "Invalid pagination offset.", "INVALID_PAGINATION");
    }
    const parsed = Number(offsetRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
      throw new HttpError(
        400,
        "Pagination offset is out of supported range.",
        "INVALID_PAGINATION",
      );
    }
    offset = parsed;
  }

  const qRaw = url.searchParams.get("q");
  const query = qRaw ? stripControlChars(qRaw).trim().slice(0, 160) : undefined;

  if (
    !status &&
    !reviewStatus &&
    !batchId &&
    !query &&
    limit === undefined &&
    offset === undefined
  ) {
    return undefined;
  }
  return { status, reviewStatus, batchId, query, limit, offset };
}

export async function handleListDocuments(
  request: Request,
  overrides?: {
    sql?: Pick<SqlClient, "query"> | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "GET") {
      return methodNotAllowedResponse("GET");
    }
    const url = new URL(request.url);
    rejectClientWorkspaceId(Object.fromEntries(url.searchParams));
    const options = parseDocumentListOptions(url);
    const sql = overrides?.sql ?? getSql(request);
    const { workspace } = await requireWorkspaceContext(sql, request);
    const result = await listWorkspaceDocuments(sql, workspace.id, options);
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof HttpError && error.status === 405) {
      return methodNotAllowedResponse("GET");
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/documents GET] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/documents")({
  server: {
    handlers: {
      GET: async ({ request }) => handleListDocuments(request),
      ANY: () => methodNotAllowedResponse("GET"),
    },
  },
});
