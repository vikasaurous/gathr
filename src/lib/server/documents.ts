import "@tanstack/react-start/server-only";
import {
  buildStorageKey,
  computeBatchFinalStatus,
  hasPdfSignature,
  isSafeStorageKey,
  isUuid,
  MAX_FILE_BYTES,
  normalizeMimeType,
  PDF_MIME_TYPE,
  PDF_SIGNATURE_BYTES,
  sanitizeDownloadFilename,
  toAsciiHeaderFilename,
  type CancelUploadResponse,
  type PersistedBatch,
  type PersistedDocument,
  type UploadDocumentResponse,
} from "@/lib/gathr/ingestion-types";
import {
  B2ObjectNotFoundError,
  B2StorageError,
  getB2StorageClient,
  type B2StorageClient,
} from "./b2-storage";
import { toPublicBatch, toPublicDocument } from "./batches";
import { HttpError } from "./env";
import {
  assertSameOrigin,
  mapBatchRow,
  mapDocumentRow,
  rejectClientWorkspaceId,
  requireOwnedBatch,
  requireOwnedDocument,
  requireWorkspaceContext,
  type OwnedBatchRow,
  type OwnedDocumentRow,
} from "./ownership";
import type { SqlClient } from "./sql";

export const DEFAULT_UPLOAD_LEASE_SECONDS = 300;
const PDF_SIG_LEN = PDF_SIGNATURE_BYTES.length;

export interface InternalUploadClaim {
  document: OwnedDocumentRow;
  attemptId: string;
  storageKey: string;
  leaseExpiresAt: string;
}

export type CleanupReason = "orphaned_attempt" | "upload_failed";

function isStorageSchemaUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

function rethrowDbError(operation: string, error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (isStorageSchemaUnavailableError(error)) {
    console.error(`[documents] ${operation} blocked: database schema is not migrated.`);
    throw new HttpError(503, "Document storage is not set up.", "STORAGE_NOT_MIGRATED");
  }
  throw error;
}

async function refreshBatchStatus(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  batchId: string,
): Promise<OwnedBatchRow> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const stateRows = await sql.query(
      `SELECT
         b."id",
         b."workspace_id",
         b."name",
         b."status",
         b."updated_at"::text AS "updated_at_raw",
         COUNT(d."id")::int AS "total_count",
         COUNT(d."id") FILTER (WHERE d."status" IN ('pending_upload', 'uploading'))::int AS "active_count",
         COUNT(d."id") FILTER (WHERE d."status" = 'uploaded')::int AS "uploaded_count"
       FROM "batches" b
       LEFT JOIN "documents" d
         ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
       WHERE b."id" = $1::uuid AND b."workspace_id" = $2::uuid
       GROUP BY b."id"`,
      [batchId, workspaceId],
    );

    const row = stateRows[0];
    if (!row) {
      throw new HttpError(404, "Batch not found.", "BATCH_NOT_FOUND");
    }

    const totalCount = Number(row["total_count"] ?? 0);
    const activeCount = Number(row["active_count"] ?? 0);
    const uploadedCount = Number(row["uploaded_count"] ?? 0);
    const nextStatus =
      activeCount > 0 ? "uploading" : computeBatchFinalStatus(totalCount, uploadedCount);

    const updatedRows = await sql.query(
      `UPDATE "batches"
       SET "status" = $3::text, "updated_at" = clock_timestamp()
       WHERE "id" = $1::uuid
         AND "workspace_id" = $2::uuid
         AND "updated_at"::text = $4::text
       RETURNING "id", "workspace_id", "name", "status", "created_at", "updated_at"`,
      [batchId, workspaceId, nextStatus, String(row["updated_at_raw"])],
    );

    const updated = updatedRows[0];
    if (updated) {
      return mapBatchRow(updated);
    }
  }

  return requireOwnedBatch(sql, workspaceId, batchId);
}

/**
 * Atomically claims an exclusive upload attempt on a workspace-owned document.
 * Concurrent unexpired attempts fail with 409; expired attempts are superseded
 * and their attempt-specific key is durably queued in storage_cleanup_outbox.
 */
export async function claimDocumentUploadAttempt(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    documentId: string;
    bucketName: string;
    declaredSizeBytes: number;
    leaseSeconds?: number | undefined;
  },
): Promise<InternalUploadClaim> {
  const {
    workspaceId,
    documentId,
    bucketName,
    declaredSizeBytes,
    leaseSeconds = DEFAULT_UPLOAD_LEASE_SECONDS,
  } = params;

  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }
  if (
    !Number.isSafeInteger(declaredSizeBytes) ||
    declaredSizeBytes <= 0 ||
    declaredSizeBytes > MAX_FILE_BYTES
  ) {
    throw new HttpError(400, "Invalid declared file size.", "INVALID_CONTENT_LENGTH");
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new HttpError(400, "Invalid upload lease duration.", "INVALID_LEASE");
  }
  if (!bucketName.trim()) {
    throw new HttpError(503, "Object storage bucket is not configured.", "STORAGE_NOT_CONFIGURED");
  }

  const attemptId = globalThis.crypto.randomUUID();

  try {
    const rows = await sql.query(
      `WITH prev AS (
         SELECT
           "id", "workspace_id", "batch_id", "file_size_bytes",
           "status", "active_attempt_id", "lease_expires_at"
         FROM "documents"
         WHERE "id" = $1::uuid AND "workspace_id" = $2::uuid
         FOR UPDATE
       ),
       claimed AS (
         UPDATE "documents" d
         SET
           "status" = 'uploading',
           "active_attempt_id" = $3::uuid,
           "lease_expires_at" = clock_timestamp() + ($4::integer * interval '1 second'),
           "upload_started_at" = clock_timestamp(),
           "error_message" = NULL,
           "updated_at" = clock_timestamp()
         FROM prev p
         WHERE d."id" = p."id"
           AND d."workspace_id" = p."workspace_id"
           AND d."file_size_bytes" = $5::bigint
           AND (
             d."status" IN ('pending_upload', 'failed')
             OR (
               d."status" = 'uploading'
               AND (d."lease_expires_at" IS NULL OR d."lease_expires_at" <= clock_timestamp())
             )
           )
         RETURNING
           d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
           d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
           d."upload_started_at", d."status", d."review_status", d."page_count",
           d."error_message", d."uploaded_at", d."created_at", d."updated_at"
       ),
       orphan_outbox AS (
         INSERT INTO "storage_cleanup_outbox" (
           "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
         )
         SELECT
           'gathr/' || p."workspace_id"::text || '/' || p."batch_id"::text || '/' || p."id"::text || '/' || p."active_attempt_id"::text || '.pdf',
           $6::text,
           p."workspace_id",
           p."batch_id",
           p."id",
           'orphaned_attempt'
         FROM prev p
         INNER JOIN claimed c ON c."id" = p."id"
         WHERE p."active_attempt_id" IS NOT NULL
         ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
         DO NOTHING
         RETURNING "id"
       )
       SELECT
         p."id" AS "prev_id",
         p."status" AS "prev_status",
         p."file_size_bytes" AS "prev_file_size_bytes",
         c."id" AS "claimed_id",
         c."workspace_id",
         c."batch_id",
         c."original_filename",
         c."mime_type",
         c."file_size_bytes",
         c."storage_key",
         c."active_attempt_id",
         c."lease_expires_at",
         c."upload_started_at",
         c."status",
         c."review_status",
         c."page_count",
         c."error_message",
         c."uploaded_at",
         c."created_at",
         c."updated_at"
       FROM prev p
       LEFT JOIN claimed c ON c."id" = p."id"`,
      [documentId, workspaceId, attemptId, leaseSeconds, declaredSizeBytes, bucketName],
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
    }

    if (!row["claimed_id"]) {
      const prevStatus = String(row["prev_status"]);
      const expectedSize = Number(row["prev_file_size_bytes"]);
      if (prevStatus === "uploaded") {
        throw new HttpError(
          409,
          "This document has already been uploaded.",
          "DOCUMENT_ALREADY_UPLOADED",
        );
      }
      if (expectedSize !== declaredSizeBytes) {
        throw new HttpError(
          400,
          "Uploaded file size does not match the document record.",
          "SIZE_MISMATCH",
        );
      }
      throw new HttpError(
        409,
        "An upload attempt is already active for this document.",
        "UPLOAD_IN_PROGRESS",
      );
    }

    const document = mapDocumentRow({
      ...row,
      id: row["claimed_id"],
    });
    await refreshBatchStatus(sql, workspaceId, document.batchId);

    const storageKey = buildStorageKey({
      workspaceId: document.workspaceId,
      batchId: document.batchId,
      documentId: document.id,
      attemptId,
    });

    return {
      document,
      attemptId,
      storageKey,
      leaseExpiresAt: document.leaseExpiresAt ?? new Date().toISOString(),
    };
  } catch (error) {
    rethrowDbError("claimDocumentUploadAttempt", error);
  }
}

/**
 * Commits a completed B2 object as the document's canonical storage reference
 * only if the caller still owns the current active attempt and its lease has
 * not expired. Stale/late attempts never overwrite canonical state and are
 * queued in storage_cleanup_outbox for deletion.
 */
export async function commitDocumentUploadAttempt(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    documentId: string;
    attemptId: string;
    storageKey: string;
    bucketName: string;
  },
): Promise<{ document: OwnedDocumentRow; batch: OwnedBatchRow }> {
  const { workspaceId, documentId, attemptId, storageKey, bucketName } = params;

  if (!isUuid(documentId) || !isUuid(attemptId)) {
    throw new HttpError(400, "Invalid upload attempt identifier.", "INVALID_ATTEMPT");
  }
  if (!isSafeStorageKey(storageKey)) {
    throw new HttpError(400, "Invalid storage key.", "INVALID_STORAGE_KEY");
  }

  try {
    const rows = await sql.query(
      `WITH target AS (
         SELECT
           "id", "workspace_id", "batch_id", "status", "active_attempt_id", "lease_expires_at"
         FROM "documents"
         WHERE "id" = $1::uuid AND "workspace_id" = $2::uuid
         FOR UPDATE
       ),
       committed AS (
         UPDATE "documents" d
         SET
           "status" = 'uploaded',
           "storage_key" = $4::text,
           "active_attempt_id" = NULL,
           "lease_expires_at" = NULL,
           "error_message" = NULL,
           "uploaded_at" = clock_timestamp(),
           "updated_at" = clock_timestamp()
         FROM target t
         WHERE d."id" = t."id"
           AND d."workspace_id" = t."workspace_id"
           AND d."active_attempt_id" = $3::uuid
           AND d."status" = 'uploading'
           AND (d."lease_expires_at" IS NULL OR d."lease_expires_at" > clock_timestamp())
         RETURNING
           d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
           d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
           d."upload_started_at", d."status", d."review_status", d."page_count",
           d."error_message", d."uploaded_at", d."created_at", d."updated_at"
       ),
       expired_self AS (
         UPDATE "documents" d
         SET
           "status" = 'failed',
           "active_attempt_id" = NULL,
           "lease_expires_at" = NULL,
           "error_message" = 'Upload lease expired before confirmation.',
           "updated_at" = clock_timestamp()
         FROM target t
         WHERE NOT EXISTS (SELECT 1 FROM committed)
           AND d."id" = t."id"
           AND d."workspace_id" = t."workspace_id"
           AND d."active_attempt_id" = $3::uuid
           AND d."status" = 'uploading'
         RETURNING d."id", d."batch_id"
       ),
       orphan_outbox AS (
         INSERT INTO "storage_cleanup_outbox" (
           "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
         )
         SELECT
           $4::text,
           $5::text,
           t."workspace_id",
           t."batch_id",
           t."id",
           'orphaned_attempt'
         FROM target t
         WHERE NOT EXISTS (SELECT 1 FROM committed)
         ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
         DO NOTHING
         RETURNING "id"
       )
       SELECT
         t."id" AS "target_id",
         t."batch_id" AS "target_batch_id",
         t."status" AS "target_status",
         t."active_attempt_id" AS "target_attempt_id",
         es."id" AS "expired_self_id",
         c."id" AS "committed_id",
         c."workspace_id",
         c."batch_id",
         c."original_filename",
         c."mime_type",
         c."file_size_bytes",
         c."storage_key",
         c."active_attempt_id",
         c."lease_expires_at",
         c."upload_started_at",
         c."status",
         c."review_status",
         c."page_count",
         c."error_message",
         c."uploaded_at",
         c."created_at",
         c."updated_at"
       FROM target t
       LEFT JOIN committed c ON c."id" = t."id"
       LEFT JOIN expired_self es ON es."id" = t."id"`,
      [documentId, workspaceId, attemptId, storageKey, bucketName],
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
    }

    if (!row["committed_id"]) {
      if (row["expired_self_id"]) {
        await refreshBatchStatus(sql, workspaceId, String(row["target_batch_id"]));
        throw new HttpError(
          409,
          "Upload lease expired before confirmation.",
          "UPLOAD_LEASE_EXPIRED",
        );
      }
      throw new HttpError(
        409,
        "Upload attempt is no longer active and cannot commit.",
        "UPLOAD_ATTEMPT_SUPERSEDED",
      );
    }

    const document = mapDocumentRow({
      ...row,
      id: row["committed_id"],
    });
    const batch = await refreshBatchStatus(sql, workspaceId, document.batchId);
    return { document, batch };
  } catch (error) {
    rethrowDbError("commitDocumentUploadAttempt", error);
  }
}

/**
 * Marks the specified active attempt as failed (never touching a newer or
 * already-committed attempt) and optionally persists an orphan cleanup job.
 */
export async function failDocumentUploadAttempt(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    documentId: string;
    attemptId: string;
    storageKey: string;
    bucketName: string;
    errorMessage: string;
    enqueueCleanup: boolean;
    cleanupReason?: CleanupReason | undefined;
  },
): Promise<void> {
  const {
    workspaceId,
    documentId,
    attemptId,
    storageKey,
    bucketName,
    errorMessage,
    enqueueCleanup,
    cleanupReason = "upload_failed",
  } = params;

  const safeMessage = errorMessage.trim().slice(0, 300) || "Upload failed.";

  try {
    const rows = await sql.query(
      `WITH target AS (
         SELECT "id", "workspace_id", "batch_id", "status", "active_attempt_id"
         FROM "documents"
         WHERE "id" = $1::uuid AND "workspace_id" = $2::uuid
         FOR UPDATE
       ),
       failed AS (
         UPDATE "documents" d
         SET
           "status" = 'failed',
           "active_attempt_id" = NULL,
           "lease_expires_at" = NULL,
           "error_message" = $4::text,
           "updated_at" = clock_timestamp()
         FROM target t
         WHERE d."id" = t."id"
           AND d."workspace_id" = t."workspace_id"
           AND d."active_attempt_id" = $3::uuid
           AND d."status" = 'uploading'
         RETURNING d."id", d."batch_id"
       ),
       outbox AS (
         INSERT INTO "storage_cleanup_outbox" (
           "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
         )
         SELECT
           $5::text,
           $6::text,
           t."workspace_id",
           t."batch_id",
           t."id",
           CASE WHEN EXISTS (SELECT 1 FROM failed) THEN $7::text ELSE 'orphaned_attempt' END
         FROM target t
         WHERE $8::boolean = true
         ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
         DO NOTHING
         RETURNING "id"
       )
       SELECT
         t."batch_id",
         f."id" AS "failed_id"
       FROM target t
       LEFT JOIN failed f ON f."id" = t."id"`,
      [
        documentId,
        workspaceId,
        attemptId,
        safeMessage,
        storageKey,
        bucketName,
        cleanupReason,
        enqueueCleanup,
      ],
    );

    const row = rows[0];
    if (row?.["failed_id"]) {
      await refreshBatchStatus(sql, workspaceId, String(row["batch_id"]));
    }
  } catch (error) {
    rethrowDbError("failDocumentUploadAttempt", error);
  }
}

export async function cancelDocumentUploadAttempt(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    documentId: string;
    bucketName: string;
    attemptId?: string | undefined;
  },
): Promise<CancelUploadResponse> {
  const { workspaceId, documentId, bucketName, attemptId } = params;
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }
  if (attemptId !== undefined && !isUuid(attemptId)) {
    throw new HttpError(400, "Invalid attempt identifier.", "INVALID_ATTEMPT");
  }

  try {
    const rows = await sql.query(
      `WITH target AS (
         SELECT
           "id", "workspace_id", "batch_id", "status", "active_attempt_id"
         FROM "documents"
         WHERE "id" = $1::uuid AND "workspace_id" = $2::uuid
         FOR UPDATE
       ),
       cancelled AS (
         UPDATE "documents" d
         SET
           "status" = 'failed',
           "active_attempt_id" = NULL,
           "lease_expires_at" = NULL,
           "error_message" = 'Upload cancelled.',
           "updated_at" = clock_timestamp()
         FROM target t
         WHERE d."id" = t."id"
           AND d."workspace_id" = t."workspace_id"
           AND d."status" = 'uploading'
           AND ($3::uuid IS NULL OR d."active_attempt_id" = $3::uuid)
         RETURNING
           d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
           d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
           d."upload_started_at", d."status", d."review_status", d."page_count",
           d."error_message", d."uploaded_at", d."created_at", d."updated_at"
       ),
       outbox AS (
         INSERT INTO "storage_cleanup_outbox" (
           "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
         )
         SELECT
           'gathr/' || t."workspace_id"::text || '/' || t."batch_id"::text || '/' || t."id"::text || '/' || t."active_attempt_id"::text || '.pdf',
           $4::text,
           t."workspace_id",
           t."batch_id",
           t."id",
           'upload_failed'
         FROM target t
         INNER JOIN cancelled c ON c."id" = t."id"
         WHERE t."active_attempt_id" IS NOT NULL
         ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
         DO NOTHING
         RETURNING "id"
       )
       SELECT
         t."id" AS "target_id",
         c."id" AS "cancelled_id"
       FROM target t
       LEFT JOIN cancelled c ON c."id" = t."id"`,
      [documentId, workspaceId, attemptId ?? null, bucketName],
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
    }

    const cancelled = Boolean(row["cancelled_id"]);
    const doc = await requireOwnedDocument(sql, workspaceId, documentId);
    const batch = cancelled
      ? await refreshBatchStatus(sql, workspaceId, doc.batchId)
      : await requireOwnedBatch(sql, workspaceId, doc.batchId);

    return {
      document: toPublicDocument(doc),
      batch: toPublicBatch(batch),
      cancelled,
    };
  } catch (error) {
    rethrowDbError("cancelDocumentUploadAttempt", error);
  }
}

interface PreparedPdfUploadStream {
  stream: ReadableStream<Uint8Array>;
  hasForwardedBytes: () => boolean;
  getStreamError: () => HttpError | null;
  releaseReader: () => Promise<void>;
}

/**
 * Peeks only the first 5 bytes (`%PDF-`) before upstream storage is invoked,
 * then streams chunks without buffering the PDF while enforcing the exact
 * expected byte length and MAX_FILE_BYTES ceiling.
 */
async function preparePdfUploadStream(
  body: ReadableStream<Uint8Array>,
  expectedSizeBytes: number,
  onStreamError: (err: HttpError) => void,
): Promise<PreparedPdfUploadStream> {
  const reader = body.getReader();
  const initialChunks: Uint8Array[] = [];
  let initialBytes = 0;
  let initialDone = false;

  try {
    while (initialBytes < PDF_SIG_LEN) {
      const { done, value } = await reader.read();
      if (done) {
        initialDone = true;
        break;
      }
      if (value.byteLength === 0) continue;

      initialBytes += value.byteLength;
      if (initialBytes > MAX_FILE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "File exceeds the 50 MiB limit.", "PAYLOAD_TOO_LARGE");
      }
      if (initialBytes > expectedSizeBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(
          400,
          "Uploaded payload exceeds the declared file size.",
          "SIZE_MISMATCH",
        );
      }
      initialChunks.push(value);
    }

    if (initialBytes < PDF_SIG_LEN) {
      await reader.cancel().catch(() => {});
      throw new HttpError(
        400,
        "File is not a valid PDF (missing %PDF- signature).",
        "INVALID_PDF_SIGNATURE",
      );
    }

    const header = new Uint8Array(PDF_SIG_LEN);
    let offset = 0;
    for (const chunk of initialChunks) {
      const take = Math.min(chunk.byteLength, PDF_SIG_LEN - offset);
      header.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= PDF_SIG_LEN) break;
    }

    if (!hasPdfSignature(header)) {
      await reader.cancel().catch(() => {});
      throw new HttpError(
        400,
        "File is not a valid PDF (missing %PDF- signature).",
        "INVALID_PDF_SIGNATURE",
      );
    }

    if (initialDone && initialBytes !== expectedSizeBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(
        400,
        "Uploaded stream was truncated before reaching the declared size.",
        "TRUNCATED_STREAM",
      );
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  let initialCursor = 0;
  let streamedBytes = 0;
  let forwardedBytes = 0;
  let streamError: HttpError | null = null;

  const failStream = (err: HttpError, controller: ReadableStreamDefaultController<Uint8Array>) => {
    streamError = err;
    onStreamError(err);
    controller.error(err);
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (initialCursor < initialChunks.length) {
          const chunk = initialChunks[initialCursor++]!;
          streamedBytes += chunk.byteLength;
          forwardedBytes += chunk.byteLength;
          controller.enqueue(chunk);
          if (initialCursor >= initialChunks.length && initialDone) {
            if (streamedBytes !== expectedSizeBytes) {
              failStream(
                new HttpError(
                  400,
                  "Uploaded stream was truncated before reaching the declared size.",
                  "TRUNCATED_STREAM",
                ),
                controller,
              );
              return;
            }
            controller.close();
          }
          return;
        }

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (streamedBytes !== expectedSizeBytes) {
                failStream(
                  new HttpError(
                    400,
                    "Uploaded stream was truncated before reaching the declared size.",
                    "TRUNCATED_STREAM",
                  ),
                  controller,
                );
                return;
              }
              controller.close();
              return;
            }

            if (value.byteLength === 0) continue;

            streamedBytes += value.byteLength;
            if (streamedBytes > MAX_FILE_BYTES) {
              await reader.cancel().catch(() => {});
              failStream(
                new HttpError(413, "File exceeds the 50 MiB limit.", "PAYLOAD_TOO_LARGE"),
                controller,
              );
              return;
            }
            if (streamedBytes > expectedSizeBytes) {
              await reader.cancel().catch(() => {});
              failStream(
                new HttpError(
                  400,
                  "Uploaded payload exceeds the declared file size.",
                  "SIZE_MISMATCH",
                ),
                controller,
              );
              return;
            }

            forwardedBytes += value.byteLength;
            controller.enqueue(value);
            return;
          }
        } catch (err) {
          const mapped =
            err instanceof HttpError
              ? err
              : new HttpError(400, "Upload stream was interrupted.", "STREAM_INTERRUPTED");
          failStream(mapped, controller);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );

  return {
    stream,
    hasForwardedBytes: () => forwardedBytes > 0,
    getStreamError: () => streamError,
    releaseReader: async () => {
      await reader.cancel().catch(() => {});
    },
  };
}

function parseDeclaredUploadLength(request: Request): number {
  const rawLength = request.headers.get("content-length");
  if (rawLength === null || !rawLength.trim()) {
    throw new HttpError(411, "Content-Length header is required.", "CONTENT_LENGTH_REQUIRED");
  }
  const trimmed = rawLength.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new HttpError(400, "Invalid Content-Length header.", "INVALID_CONTENT_LENGTH");
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "File size must be greater than 0 bytes.", "INVALID_CONTENT_LENGTH");
  }
  if (parsed > MAX_FILE_BYTES) {
    throw new HttpError(413, "File exceeds the 50 MiB limit.", "PAYLOAD_TOO_LARGE");
  }
  return parsed;
}

export interface DocumentRouteDeps {
  sql: Pick<SqlClient, "query">;
  b2?: B2StorageClient | undefined;
  leaseSeconds?: number | undefined;
}

/**
 * Handles PUT /api/documents/:id/upload end-to-end:
 * method/CSRF/auth/ownership checks, declared & streamed size + PDF magic-byte
 * validation, exclusive DB attempt claim, streaming B2 PutObject with client
 * cancellation propagation, and attempt-fenced commit + orphan outbox durability.
 */
export async function uploadDocumentStream(
  request: Request,
  documentId: string,
  deps: DocumentRouteDeps,
): Promise<UploadDocumentResponse> {
  if (request.method !== "PUT") {
    throw new HttpError(405, "Method not allowed. Use PUT.", "METHOD_NOT_ALLOWED");
  }

  assertSameOrigin(request);
  rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));

  const normalizedMime = normalizeMimeType(request.headers.get("content-type"));
  if (normalizedMime !== PDF_MIME_TYPE) {
    throw new HttpError(415, "Content-Type must be application/pdf.", "UNSUPPORTED_MEDIA_TYPE");
  }

  const declaredSizeBytes = parseDeclaredUploadLength(request);
  if (!request.body) {
    throw new HttpError(400, "PDF request body is required.", "EMPTY_BODY");
  }
  if (request.signal.aborted) {
    throw new HttpError(499, "Upload was cancelled.", "UPLOAD_CANCELLED");
  }

  const { workspace } = await requireWorkspaceContext(deps.sql, request);
  const existing = await requireOwnedDocument(deps.sql, workspace.id, documentId);

  if (existing.status === "uploaded") {
    throw new HttpError(
      409,
      "This document has already been uploaded.",
      "DOCUMENT_ALREADY_UPLOADED",
    );
  }
  if (existing.fileSizeBytes !== declaredSizeBytes) {
    throw new HttpError(
      400,
      "Uploaded file size does not match the document record.",
      "SIZE_MISMATCH",
    );
  }
  if (
    existing.status === "uploading" &&
    existing.leaseExpiresAt !== null &&
    new Date(existing.leaseExpiresAt).getTime() > Date.now()
  ) {
    throw new HttpError(
      409,
      "An upload attempt is already active for this document.",
      "UPLOAD_IN_PROGRESS",
    );
  }

  const b2 = deps.b2 ?? getB2StorageClient(request);

  const upstreamController = new AbortController();
  let streamValidationError: HttpError | null = null;
  const prepared = await preparePdfUploadStream(request.body, declaredSizeBytes, (err) => {
    streamValidationError = err;
    upstreamController.abort(err);
  });

  let claim: InternalUploadClaim;
  try {
    claim = await claimDocumentUploadAttempt(deps.sql, {
      workspaceId: workspace.id,
      documentId,
      bucketName: b2.bucketName,
      declaredSizeBytes,
      leaseSeconds: deps.leaseSeconds,
    });
  } catch (err) {
    await prepared.releaseReader();
    throw err;
  }

  const onRequestAbort = () => {
    upstreamController.abort(new Error("Client aborted upload request."));
  };
  if (request.signal.aborted) {
    upstreamController.abort(new Error("Client aborted upload request."));
  } else {
    request.signal.addEventListener("abort", onRequestAbort, { once: true });
  }

  let uploadCompleted = false;
  try {
    await b2.putObject({
      key: claim.storageKey,
      body: prepared.stream,
      contentLength: declaredSizeBytes,
      contentType: PDF_MIME_TYPE,
      signal: upstreamController.signal,
    });
    uploadCompleted = true;
  } catch (error) {
    const activeStreamErr = streamValidationError ?? prepared.getStreamError();
    const wasAbortedByClient = request.signal.aborted && !activeStreamErr;
    const failureMessage = wasAbortedByClient
      ? "Upload was cancelled."
      : activeStreamErr
        ? activeStreamErr.message
        : "Could not store PDF in object storage.";

    await failDocumentUploadAttempt(deps.sql, {
      workspaceId: workspace.id,
      documentId,
      attemptId: claim.attemptId,
      storageKey: claim.storageKey,
      bucketName: b2.bucketName,
      errorMessage: failureMessage,
      enqueueCleanup: prepared.hasForwardedBytes(),
      cleanupReason: "upload_failed",
    }).catch((failErr) => {
      console.error("[documents] failed to persist upload failure state", failErr);
    });

    if (wasAbortedByClient) {
      throw new HttpError(499, "Upload was cancelled.", "UPLOAD_CANCELLED");
    }
    if (activeStreamErr) {
      throw activeStreamErr;
    }
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof B2StorageError) {
      throw new HttpError(502, "Could not store PDF in object storage.", "STORAGE_UPLOAD_FAILED");
    }
    throw new HttpError(502, "Could not store PDF in object storage.", "STORAGE_UPLOAD_FAILED");
  } finally {
    request.signal.removeEventListener("abort", onRequestAbort);
  }

  try {
    const committed = await commitDocumentUploadAttempt(deps.sql, {
      workspaceId: workspace.id,
      documentId,
      attemptId: claim.attemptId,
      storageKey: claim.storageKey,
      bucketName: b2.bucketName,
    });
    return {
      document: toPublicDocument(committed.document),
      batch: toPublicBatch(committed.batch),
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      throw error;
    }
    if (uploadCompleted) {
      await failDocumentUploadAttempt(deps.sql, {
        workspaceId: workspace.id,
        documentId,
        attemptId: claim.attemptId,
        storageKey: claim.storageKey,
        bucketName: b2.bucketName,
        errorMessage: "Upload could not be confirmed in the database.",
        enqueueCleanup: true,
        cleanupReason: "orphaned_attempt",
      }).catch(() => {});
    }
    throw error;
  }
}

function formatContentDisposition(filename: string, asAttachment: boolean): string {
  const mode = asAttachment ? "attachment" : "inline";
  const ascii = toAsciiHeaderFilename(filename);
  const utf8Name = sanitizeDownloadFilename(filename);
  const encoded = encodeURIComponent(utf8Name).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Handles GET /api/documents/:id/content — authorized, workspace-scoped private
 * PDF streaming retrieval with strict private/no-store caching headers.
 */
export async function streamOwnedDocumentContent(
  request: Request,
  documentId: string,
  deps: Omit<DocumentRouteDeps, "leaseSeconds">,
): Promise<Response> {
  if (request.method !== "GET") {
    throw new HttpError(405, "Method not allowed. Use GET.", "METHOD_NOT_ALLOWED");
  }

  const url = new URL(request.url);
  rejectClientWorkspaceId(Object.fromEntries(url.searchParams));

  const { workspace } = await requireWorkspaceContext(deps.sql, request);
  const doc = await requireOwnedDocument(deps.sql, workspace.id, documentId);

  if (doc.status !== "uploaded" || !doc.storageKey || !isSafeStorageKey(doc.storageKey)) {
    throw new HttpError(409, "Document PDF is not available yet.", "DOCUMENT_NOT_UPLOADED");
  }

  const b2 = deps.b2 ?? getB2StorageClient(request);

  let obj;
  try {
    obj = await b2.getObject({
      key: doc.storageKey,
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof B2ObjectNotFoundError) {
      throw new HttpError(404, "Stored PDF object could not be found.", "DOCUMENT_CONTENT_MISSING");
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not retrieve PDF from object storage.", "STORAGE_UNAVAILABLE");
  }

  const downloadParam = url.searchParams.get("download");
  const dispositionParam = url.searchParams.get("disposition");
  const asAttachment = downloadParam === "1" || dispositionParam === "attachment";

  const headers = new Headers({
    "Content-Type": PDF_MIME_TYPE,
    "Content-Disposition": formatContentDisposition(doc.originalFilename, asAttachment),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });

  const resolvedLength = obj.contentLength ?? doc.fileSizeBytes;
  if (Number.isSafeInteger(resolvedLength) && resolvedLength > 0) {
    headers.set("Content-Length", String(resolvedLength));
  }

  return new Response(obj.body, { status: 200, headers });
}

export function methodNotAllowedResponse(allow: string): Response {
  return new Response(
    JSON.stringify({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }),
    {
      status: 405,
      headers: {
        Allow: allow,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export type PublicUploadResult = {
  document: PersistedDocument;
  batch: PersistedBatch;
};
