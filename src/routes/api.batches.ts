/**
 * /api/batches — workspace-scoped batch listing (GET) and creation (POST).
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  BatchCreateValidationError,
  validateCreateBatchPayload,
  validateIdempotencyKey,
} from "@/lib/gathr/ingestion-types";
import { createBatchInWorkspace, listWorkspaceBatches } from "@/lib/server/batches";
import { HttpError, jsonResponse, toSafeErrorResponse } from "@/lib/server/env";
import {
  assertSameOrigin,
  rejectClientWorkspaceId,
  requireWorkspaceContext,
} from "@/lib/server/ownership";
import { getSql } from "@/lib/server/sql";

const MAX_CREATE_BATCH_JSON_BYTES = 64 * 1024;

async function readBoundedJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.", "UNSUPPORTED_MEDIA_TYPE");
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CREATE_BATCH_JSON_BYTES) {
      throw new HttpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
    }
  }

  let rawText = "";
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CREATE_BATCH_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
      }
      rawText += decoder.decode(value, { stream: true });
    }
    rawText += decoder.decode();
  } else {
    rawText = await request.text();
    if (new TextEncoder().encode(rawText).byteLength > MAX_CREATE_BATCH_JSON_BYTES) {
      throw new HttpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
    }
  }

  if (!rawText.trim()) {
    throw new HttpError(400, "Request body is required.", "INVALID_JSON");
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new HttpError(400, "Malformed JSON request body.", "INVALID_JSON");
  }
}

export async function handleGetBatches(request: Request): Promise<Response> {
  try {
    rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));
    const sql = getSql(request);
    const { workspace } = await requireWorkspaceContext(sql, request);
    const batches = await listWorkspaceBatches(sql, workspace.id);
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

    const body = await readBoundedJsonBody(request);
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
    },
  },
});
