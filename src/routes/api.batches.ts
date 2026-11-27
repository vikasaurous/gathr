/**
 * /api/batches — workspace-scoped batch listing (GET) and creation (POST).
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  BatchCreateValidationError,
  stripControlChars,
  validateCreateBatchPayload,
  validateIdempotencyKey,
  type BatchIngestionStatus,
} from "@/lib/gathr/ingestion-types";
import { createBatchInWorkspace, listWorkspaceBatches } from "@/lib/server/batches";
import { methodNotAllowedResponse } from "@/lib/server/documents";
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
import { getSql } from "@/lib/server/sql";

const MAX_CREATE_BATCH_JSON_BYTES = 64 * 1024;

const VALID_BATCH_STATUSES = new Set<BatchIngestionStatus>([
  "uploading",
  "uploaded",
  "partial",
  "failed",
]);

function parseBatchListOptions(url: URL) {
  const statusRaw = url.searchParams.get("status");
  let status: BatchIngestionStatus | undefined;
  if (statusRaw !== null && statusRaw !== "") {
    if (!VALID_BATCH_STATUSES.has(statusRaw as BatchIngestionStatus)) {
      throw new HttpError(400, "Invalid batch status filter.", "INVALID_BATCH_STATUS");
    }
    status = statusRaw as BatchIngestionStatus;
  }

  const limitRaw = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d+$/.test(limitRaw)) {
      throw new HttpError(400, "Invalid pagination limit.", "INVALID_PAGINATION");
    }
    const parsed = Number(limitRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new HttpError(400, "Pagination limit must be between 1 and 100.", "INVALID_PAGINATION");
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

  if (!status && !query && limit === undefined && offset === undefined) {
    return undefined;
  }
  return { status, query, limit, offset };
}

export async function handleGetBatches(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    rejectClientWorkspaceId(Object.fromEntries(url.searchParams));
    const listOptions = parseBatchListOptions(url);
    const sql = getSql(request);
    const { workspace } = await requireWorkspaceContext(sql, request);
    const batches = await listWorkspaceBatches(sql, workspace.id, listOptions);
    return jsonResponse({ batches });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/batches GET] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export async function handlePostBatches(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));

    const sql = getSql(request);
    const { workspace } = await requireWorkspaceContext(sql, request);

    const body = await readBoundedJsonBody(request, MAX_CREATE_BATCH_JSON_BYTES);
    rejectClientWorkspaceId(body);

    const rawIdempotencyKey = request.headers.has("idempotency-key")
      ? (request.headers.get("idempotency-key") ?? "")
      : undefined;
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const payload = validateCreateBatchPayload(body);

    const result = await createBatchInWorkspace(sql, workspace.id, payload, idempotencyKey);
    return jsonResponse(result, result.idempotentReplay ? 200 : 201);
  } catch (error) {
    if (error instanceof BatchCreateValidationError) {
      return jsonResponse(
        { error: error.message, code: "VALIDATION_ERROR", issues: error.issues },
        400,
      );
    }
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/batches POST] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/batches")({
  server: {
    handlers: {
      GET: async ({ request }) => handleGetBatches(request),
      POST: async ({ request }) => handlePostBatches(request),
      ANY: () => methodNotAllowedResponse("GET, POST"),
    },
  },
});
