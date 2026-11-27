import "@tanstack/react-start/server-only";
import {
  buildStorageKey,
  computeBatchFinalStatus,
  computeReviewDocumentRequestHash,
  hasPdfSignature,
  isDocumentReviewStatus,
  isSafeStorageKey,
  isUuid,
  isValidDocumentReviewTransition,
  MAX_FILE_BYTES,
  normalizeMimeType,
  PDF_MIME_TYPE,
  PDF_SIGNATURE_BYTES,
  sanitizeDownloadFilename,
  toAsciiHeaderFilename,
  type BatchIngestionStatus,
  type CancelUploadResponse,
  type DeleteDocumentResponse,
  type DocumentDetailResponse,
  type DocumentListResponse,
  type DocumentReviewEvent,
  type DocumentReviewStatus,
  type DocumentUploadStatus,
  type EffectiveDocumentReviewState,
  type HeartbeatUploadResponse,
  type PersistedBatch,
  type PersistedDocument,
  type ReviewDocumentResponse,
  type UploadDocumentResponse,
  type WorkspaceDocumentListItem,
  type WorkspaceDocumentReviewCounts,
} from "@/lib/gathr/ingestion-types";
import {
  B2ObjectNotFoundError,
  B2StorageError,
  getB2StorageClient,
  type B2StorageClient,
} from "./b2-storage";
import { toPublicBatch, toPublicDocument } from "./batches";
import { HttpError } from "./env";
import { logLifecycleEvent } from "./lifecycle-log";
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

async function enqueueOrphanOutboxFallback(
  sql: Pick<SqlClient, "query">,
  params: {
    storageKey: string;
    bucketName: string;
    workspaceId: string;
    batchId: string;
    documentId: string;
    reason: CleanupReason;
  },
): Promise<void> {
  if (!isSafeStorageKey(params.storageKey) || !params.bucketName.trim()) return;
  await sql.query(
    `INSERT INTO "storage_cleanup_outbox" (
       "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
     )
     VALUES ($1::text, $2::text, $3::uuid, $4::uuid, $5::uuid, $6::text)
     ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
     DO NOTHING`,
    [
      params.storageKey,
      params.bucketName.trim(),
      params.workspaceId,
      params.batchId,
      params.documentId,
      params.reason,
    ],
  );
}

/**
 * Recomputes a batch's server-authoritative status from persisted document
 * outcomes while holding `FOR UPDATE` on the parent batch row. Never alters a
 * batch that has already been sealed (`finalized_at IS NOT NULL`).
 */
export async function refreshBatchStatus(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  batchId: string,
): Promise<OwnedBatchRow> {
  const rows = await sql.query(
    `WITH batch_lock AS (
       SELECT "id", "workspace_id", "name", "status", "finalized_at", "created_at", "updated_at"
       FROM "batches"
       WHERE "id" = $1::uuid AND "workspace_id" = $2::uuid
       FOR UPDATE
     ),
     counts AS (
       SELECT
         bl."id",
         bl."workspace_id",
         bl."finalized_at",
         COUNT(d."id")::int AS "total_count",
         COUNT(d."id") FILTER (WHERE d."status" IN ('pending_upload', 'uploading'))::int AS "active_count",
         COUNT(d."id") FILTER (WHERE d."status" = 'uploaded')::int AS "uploaded_count"
       FROM batch_lock bl
       LEFT JOIN "documents" d
         ON d."batch_id" = bl."id" AND d."workspace_id" = bl."workspace_id"
       GROUP BY bl."id", bl."workspace_id", bl."finalized_at"
     ),
     updated AS (
       UPDATE "batches" b
       SET
         "status" = CASE
           WHEN c."active_count" > 0 THEN 'uploading'
           WHEN c."total_count" > 0 AND c."uploaded_count" = c."total_count" THEN 'uploaded'
           WHEN c."uploaded_count" > 0 THEN 'partial'
           ELSE 'failed'
         END,
         "updated_at" = clock_timestamp()
       FROM counts c
       WHERE b."id" = c."id"
         AND b."workspace_id" = c."workspace_id"
         AND c."finalized_at" IS NULL
       RETURNING b."id", b."workspace_id", b."name", b."status", b."finalized_at", b."created_at", b."updated_at"
     )
     SELECT
       COALESCE(u."id", bl."id") AS "id",
       COALESCE(u."workspace_id", bl."workspace_id") AS "workspace_id",
       COALESCE(u."name", bl."name") AS "name",
       COALESCE(u."status", bl."status") AS "status",
       COALESCE(u."finalized_at", bl."finalized_at") AS "finalized_at",
       COALESCE(u."created_at", bl."created_at") AS "created_at",
       COALESCE(u."updated_at", bl."updated_at") AS "updated_at"
     FROM batch_lock bl
     LEFT JOIN updated u ON u."id" = bl."id"`,
    [batchId, workspaceId],
  );

  const row = rows[0];
  if (!row) {
    throw new HttpError(404, "Batch not found.", "BATCH_NOT_FOUND");
  }
  return mapBatchRow(row);
}

/**
 * Atomically claims an exclusive upload attempt on a workspace-owned document.
 * Acquires locks in canonical order (`batches -> documents`) so finalization
 * and upload claims cannot race into an invalid state. Sealed batches reject
 * claims with `409 BATCH_FINALIZED`.
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
      `WITH batch_lock AS (
         SELECT b."id", b."workspace_id", b."finalized_at"
         FROM "batches" b
         INNER JOIN "documents" d
           ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF b
       ),
       prev AS (
         SELECT
           d."id", d."workspace_id", d."batch_id", d."file_size_bytes",
           d."status", d."active_attempt_id", d."lease_expires_at",
           bl."finalized_at" AS "batch_finalized_at"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF d
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
           AND p."batch_finalized_at" IS NULL
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
           d."upload_started_at", d."status", d."review_status", d."review_version",
           d."review_updated_at", d."page_count",
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
       ),
       batch_uploading AS (
         UPDATE "batches" b
         SET
           "status" = 'uploading',
           "updated_at" = clock_timestamp()
         FROM claimed c
         WHERE b."id" = c."batch_id"
           AND b."workspace_id" = c."workspace_id"
           AND b."finalized_at" IS NULL
         RETURNING b."id"
       )
       SELECT
         p."id" AS "prev_id",
         p."batch_id" AS "prev_batch_id",
         p."status" AS "prev_status",
         p."file_size_bytes" AS "prev_file_size_bytes",
         p."batch_finalized_at",
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
         c."review_version",
         c."review_updated_at",
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
      const batchId = String(row["prev_batch_id"]);
      if (row["batch_finalized_at"] != null) {
        logLifecycleEvent("info", {
          operation: "claim_upload",
          outcome: "rejected",
          batchId,
          documentId,
          attemptId,
          failureCategory: "batch_finalized",
        });
        throw new HttpError(
          409,
          "This batch has been finalized and no longer accepts uploads.",
          "BATCH_FINALIZED",
        );
      }

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
      logLifecycleEvent("info", {
        operation: "claim_upload",
        outcome: "rejected",
        batchId,
        documentId,
        attemptId,
        failureCategory: "conflict",
      });
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

    const storageKey = buildStorageKey({
      workspaceId: document.workspaceId,
      batchId: document.batchId,
      documentId: document.id,
      attemptId,
    });

    logLifecycleEvent("info", {
      operation: "claim_upload",
      outcome: "succeeded",
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
 * Renews an active upload attempt's lease if and only if the caller owns the
 * matching `active_attempt_id`, its lease has not already expired, and the
 * parent batch has not been finalized.
 */
export async function heartbeatDocumentUploadAttempt(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    documentId: string;
    attemptId: string;
    leaseSeconds?: number | undefined;
  },
): Promise<HeartbeatUploadResponse> {
  const {
    workspaceId,
    documentId,
    attemptId,
    leaseSeconds = DEFAULT_UPLOAD_LEASE_SECONDS,
  } = params;

  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }
  if (!isUuid(attemptId)) {
    throw new HttpError(400, "Invalid upload attempt identifier.", "INVALID_ATTEMPT");
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new HttpError(400, "Invalid upload lease duration.", "INVALID_LEASE");
  }

  try {
    const rows = await sql.query(
      `WITH batch_lock AS (
         SELECT b."id", b."workspace_id", b."finalized_at"
         FROM "batches" b
         INNER JOIN "documents" d
           ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF b
       ),
       target AS (
         SELECT
           d."id", d."workspace_id", d."batch_id", d."status",
           d."active_attempt_id", d."lease_expires_at",
           bl."finalized_at" AS "batch_finalized_at"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF d
       ),
       renewed AS (
         UPDATE "documents" d
         SET
           "lease_expires_at" = clock_timestamp() + ($4::integer * interval '1 second'),
           "updated_at" = clock_timestamp()
         FROM target t
         WHERE d."id" = t."id"
           AND d."workspace_id" = t."workspace_id"
           AND t."batch_finalized_at" IS NULL
           AND d."status" = 'uploading'
           AND d."active_attempt_id" = $3::uuid
           AND (d."lease_expires_at" IS NULL OR d."lease_expires_at" > clock_timestamp())
         RETURNING d."id", d."batch_id", d."lease_expires_at"
       )
       SELECT
         t."id" AS "target_id",
         t."batch_id",
         t."status" AS "target_status",
         t."active_attempt_id" AS "target_attempt_id",
         t."lease_expires_at" AS "target_lease_expires_at",
         t."batch_finalized_at",
         r."id" AS "renewed_id",
         r."lease_expires_at" AS "renewed_lease_expires_at"
       FROM target t
       LEFT JOIN renewed r ON r."id" = t."id"`,
      [documentId, workspaceId, attemptId, leaseSeconds],
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
    }

    const batchId = String(row["batch_id"]);
    if (!row["renewed_id"]) {
      if (row["batch_finalized_at"] != null) {
        throw new HttpError(
          409,
          "This batch has been finalized and no longer accepts uploads.",
          "BATCH_FINALIZED",
        );
      }
      if (row["target_status"] === "uploaded") {
        throw new HttpError(
          409,
          "This document has already been uploaded.",
          "DOCUMENT_ALREADY_UPLOADED",
        );
      }
      if (
        row["target_status"] === "uploading" &&
        row["target_attempt_id"] === attemptId &&
        row["target_lease_expires_at"] != null
      ) {
        logLifecycleEvent("info", {
          operation: "heartbeat_upload",
          outcome: "rejected",
          batchId,
          documentId,
          attemptId,
          failureCategory: "lease_expired",
        });
        throw new HttpError(409, "Upload lease has already expired.", "UPLOAD_LEASE_EXPIRED");
      }
      logLifecycleEvent("info", {
        operation: "heartbeat_upload",
        outcome: "rejected",
        batchId,
        documentId,
        attemptId,
        failureCategory: "attempt_superseded",
      });
      throw new HttpError(409, "Upload attempt is no longer active.", "UPLOAD_ATTEMPT_SUPERSEDED");
    }

    const leaseExpiresAt =
      row["renewed_lease_expires_at"] instanceof Date
        ? row["renewed_lease_expires_at"].toISOString()
        : String(row["renewed_lease_expires_at"]);

    return {
      documentId,
      attemptId,
      leaseExpiresAt,
    };
  } catch (error) {
    rethrowDbError("heartbeatDocumentUploadAttempt", error);
  }
}

/**
 * Commits a completed B2 object as the document's canonical storage reference
 * only if the caller still owns the current active attempt, its lease has
 * not expired, and the parent batch is not finalized. Stale/late attempts
 * never overwrite canonical state and are queued in `storage_cleanup_outbox`.
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
      `WITH batch_lock AS (
         SELECT b."id", b."workspace_id", b."finalized_at"
         FROM "batches" b
         INNER JOIN "documents" d
           ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF b
       ),
       target AS (
         SELECT
           d."id", d."workspace_id", d."batch_id", d."status",
           d."active_attempt_id", d."lease_expires_at",
           bl."finalized_at" AS "batch_finalized_at"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF d
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
           AND t."batch_finalized_at" IS NULL
           AND d."active_attempt_id" = $3::uuid
           AND d."status" = 'uploading'
           AND (d."lease_expires_at" IS NULL OR d."lease_expires_at" > clock_timestamp())
         RETURNING
           d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
           d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
           d."upload_started_at", d."status", d."review_status", d."review_version",
           d."review_updated_at", d."page_count",
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
           AND t."batch_finalized_at" IS NULL
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
         t."batch_finalized_at",
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
         c."review_version",
         c."review_updated_at",
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
      const batchId = String(row["target_batch_id"]);
      if (row["expired_self_id"]) {
        await refreshBatchStatus(sql, workspaceId, batchId);
        logLifecycleEvent("warn", {
          operation: "commit_upload",
          outcome: "rejected",
          batchId,
          documentId,
          attemptId,
          failureCategory: "lease_expired",
        });
        throw new HttpError(
          409,
          "Upload lease expired before confirmation.",
          "UPLOAD_LEASE_EXPIRED",
        );
      }
      if (row["batch_finalized_at"] != null) {
        logLifecycleEvent("warn", {
          operation: "commit_upload",
          outcome: "rejected",
          batchId,
          documentId,
          attemptId,
          failureCategory: "batch_finalized",
        });
        throw new HttpError(
          409,
          "This batch was finalized before upload confirmation.",
          "BATCH_FINALIZED",
        );
      }
      logLifecycleEvent("warn", {
        operation: "commit_upload",
        outcome: "rejected",
        batchId,
        documentId,
        attemptId,
        failureCategory: "attempt_superseded",
      });
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
    logLifecycleEvent("info", {
      operation: "commit_upload",
      outcome: "succeeded",
      batchId: document.batchId,
      documentId: document.id,
      attemptId,
    });
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
    batchId?: string | undefined;
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
    batchId,
  } = params;

  const safeMessage = errorMessage.trim().slice(0, 300) || "Upload failed.";

  try {
    const rows = await sql.query(
      `WITH batch_lock AS (
         SELECT b."id", b."workspace_id", b."finalized_at"
         FROM "batches" b
         INNER JOIN "documents" d
           ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF b
       ),
       target AS (
         SELECT
           d."id", d."workspace_id", d."batch_id", d."status", d."active_attempt_id",
           bl."finalized_at" AS "batch_finalized_at"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF d
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
           AND t."batch_finalized_at" IS NULL
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
         t."batch_finalized_at",
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
    if (!row && enqueueCleanup && batchId && isUuid(batchId)) {
      await enqueueOrphanOutboxFallback(sql, {
        storageKey,
        bucketName,
        workspaceId,
        batchId,
        documentId,
        reason: "orphaned_attempt",
      });
    } else if (row?.["failed_id"] && row["batch_finalized_at"] == null) {
      await refreshBatchStatus(sql, workspaceId, String(row["batch_id"]));
    }

    logLifecycleEvent("info", {
      operation: "fail_upload",
      outcome: "succeeded",
      batchId: row ? String(row["batch_id"]) : (batchId ?? null),
      documentId,
      attemptId,
      reason: cleanupReason,
    });
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
      `WITH batch_lock AS (
         SELECT b."id", b."workspace_id", b."finalized_at"
         FROM "batches" b
         INNER JOIN "documents" d
           ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF b
       ),
       target AS (
         SELECT
           d."id", d."workspace_id", d."batch_id", d."status", d."active_attempt_id",
           bl."finalized_at" AS "batch_finalized_at"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF d
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
           AND t."batch_finalized_at" IS NULL
           AND d."status" = 'uploading'
           AND ($3::uuid IS NULL OR d."active_attempt_id" = $3::uuid)
         RETURNING
           d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
           d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
           d."upload_started_at", d."status", d."review_status", d."review_version",
           d."review_updated_at", d."page_count",
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
         t."batch_id" AS "target_batch_id",
         t."batch_finalized_at",
         t."active_attempt_id" AS "target_attempt_id",
         c."id" AS "cancelled_id"
       FROM target t
       LEFT JOIN cancelled c ON c."id" = t."id"`,
      [documentId, workspaceId, attemptId ?? null, bucketName],
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
    }
    if (row["batch_finalized_at"] != null) {
      throw new HttpError(
        409,
        "This batch has been finalized and can no longer be modified.",
        "BATCH_FINALIZED",
      );
    }

    const cancelled = Boolean(row["cancelled_id"]);
    const doc = await requireOwnedDocument(sql, workspaceId, documentId);
    const batch = cancelled
      ? await refreshBatchStatus(sql, workspaceId, doc.batchId)
      : await requireOwnedBatch(sql, workspaceId, doc.batchId);

    logLifecycleEvent("info", {
      operation: "cancel_upload",
      outcome: "succeeded",
      batchId: doc.batchId,
      documentId: doc.id,
      attemptId:
        typeof row["target_attempt_id"] === "string" ? row["target_attempt_id"] : attemptId,
      reason: cancelled ? "server_cancelled" : `noop_${doc.status}`,
    });

    return {
      document: toPublicDocument(doc),
      batch: toPublicBatch(batch),
      cancelled,
      serverConfirmed: true,
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

interface PeekedPdfStreamHeader {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  initialChunks: Uint8Array[];
  initialBytes: number;
  initialDone: boolean;
}

/**
 * Peeks only the leading bytes needed to verify a non-empty `%PDF-` stream
 * without buffering the entire PDF in memory.
 */
async function peekPdfStreamHeader(
  body: ReadableStream<Uint8Array>,
  options: {
    expectedSizeBytes: number;
    emptyError: () => HttpError;
    invalidSigError: () => HttpError;
    exceedsSizeError: () => HttpError;
    truncatedError?: () => HttpError;
  },
): Promise<PeekedPdfStreamHeader> {
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
      if (initialBytes > options.expectedSizeBytes) {
        await reader.cancel().catch(() => {});
        throw options.exceedsSizeError();
      }
      initialChunks.push(value);
    }

    if (initialBytes === 0) {
      await reader.cancel().catch(() => {});
      throw options.emptyError();
    }
    if (initialBytes < PDF_SIG_LEN) {
      await reader.cancel().catch(() => {});
      throw options.invalidSigError();
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
      throw options.invalidSigError();
    }

    if (initialDone && initialBytes !== options.expectedSizeBytes && options.truncatedError) {
      await reader.cancel().catch(() => {});
      throw options.truncatedError();
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  return { reader, initialChunks, initialBytes, initialDone };
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
  onChunkForwarded?: () => void,
): Promise<PreparedPdfUploadStream> {
  const { reader, initialChunks, initialDone } = await peekPdfStreamHeader(body, {
    expectedSizeBytes,
    emptyError: () =>
      new HttpError(
        400,
        "File is not a valid PDF (missing %PDF- signature).",
        "INVALID_PDF_SIGNATURE",
      ),
    invalidSigError: () =>
      new HttpError(
        400,
        "File is not a valid PDF (missing %PDF- signature).",
        "INVALID_PDF_SIGNATURE",
      ),
    exceedsSizeError: () =>
      new HttpError(400, "Uploaded payload exceeds the declared file size.", "SIZE_MISMATCH"),
    truncatedError: () =>
      new HttpError(
        400,
        "Uploaded stream was truncated before reaching the declared size.",
        "TRUNCATED_STREAM",
      ),
  });

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
          onChunkForwarded?.();
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
            onChunkForwarded?.();
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
  const existingBatch = await requireOwnedBatch(deps.sql, workspace.id, existing.batchId);

  if (existingBatch.finalizedAt !== null) {
    throw new HttpError(
      409,
      "This batch has been finalized and no longer accepts uploads.",
      "BATCH_FINALIZED",
    );
  }
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

  const effectiveLeaseSeconds = deps.leaseSeconds ?? DEFAULT_UPLOAD_LEASE_SECONDS;
  const heartbeatIntervalMs = Math.max(5_000, Math.floor(effectiveLeaseSeconds * 500));
  let lastHeartbeatAt = Date.now();
  let inflightHeartbeat: Promise<void> | null = null;
  let activeClaim: InternalUploadClaim | null = null;

  const upstreamController = new AbortController();
  let streamValidationError: HttpError | null = null;
  const prepared = await preparePdfUploadStream(
    request.body,
    declaredSizeBytes,
    (err) => {
      streamValidationError = err;
      upstreamController.abort(err);
    },
    () => {
      if (!activeClaim || inflightHeartbeat) return;
      const now = Date.now();
      if (now - lastHeartbeatAt < heartbeatIntervalMs) return;
      lastHeartbeatAt = now;
      const claimRef = activeClaim;
      inflightHeartbeat = heartbeatDocumentUploadAttempt(deps.sql, {
        workspaceId: workspace.id,
        documentId,
        attemptId: claimRef.attemptId,
        leaseSeconds: effectiveLeaseSeconds,
      })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          inflightHeartbeat = null;
        });
    },
  );

  let claim: InternalUploadClaim;
  try {
    claim = await claimDocumentUploadAttempt(deps.sql, {
      workspaceId: workspace.id,
      documentId,
      bucketName: b2.bucketName,
      declaredSizeBytes,
      leaseSeconds: deps.leaseSeconds,
    });
    activeClaim = claim;
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
    if (inflightHeartbeat) {
      await inflightHeartbeat;
    }
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
      batchId: claim.document.batchId,
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

  if (inflightHeartbeat) {
    await inflightHeartbeat;
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
    if (uploadCompleted && error instanceof HttpError && error.status === 404) {
      await enqueueOrphanOutboxFallback(deps.sql, {
        storageKey: claim.storageKey,
        bucketName: b2.bucketName,
        workspaceId: workspace.id,
        batchId: claim.document.batchId,
        documentId,
        reason: "orphaned_attempt",
      }).catch(() => {});
      throw error;
    }
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
        batchId: claim.document.batchId,
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

const ALLOWED_STORAGE_DOWNLOAD_MIMES = new Set([
  PDF_MIME_TYPE,
  "application/octet-stream",
  "binary/octet-stream",
]);

/**
 * Verifies the leading `%PDF-` bytes of an object storage response before
 * committing `200 OK` headers, then streams remaining chunks lazily without
 * buffering the PDF in memory.
 */
async function preparePdfDownloadStream(
  body: ReadableStream<Uint8Array>,
  expectedSizeBytes: number,
): Promise<ReadableStream<Uint8Array>> {
  const { reader, initialChunks, initialDone } = await peekPdfStreamHeader(body, {
    expectedSizeBytes,
    emptyError: () => new HttpError(502, "Stored PDF object is empty.", "DOCUMENT_CONTENT_CORRUPT"),
    invalidSigError: () =>
      new HttpError(502, "Stored object is not a valid PDF document.", "DOCUMENT_CONTENT_INVALID"),
    exceedsSizeError: () =>
      new HttpError(
        502,
        "Stored PDF object does not match the recorded document size.",
        "DOCUMENT_CONTENT_MISMATCH",
      ),
    truncatedError: () =>
      new HttpError(
        502,
        "Stored PDF object is incomplete or corrupted.",
        "DOCUMENT_CONTENT_CORRUPT",
      ),
  });

  let initialCursor = 0;
  let streamedBytes = 0;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (initialCursor < initialChunks.length) {
          const chunk = initialChunks[initialCursor++]!;
          streamedBytes += chunk.byteLength;
          controller.enqueue(chunk);
          if (initialCursor >= initialChunks.length && initialDone) {
            if (streamedBytes !== expectedSizeBytes) {
              controller.error(
                new HttpError(
                  502,
                  "Stored PDF object is incomplete or corrupted.",
                  "DOCUMENT_CONTENT_CORRUPT",
                ),
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
                controller.error(
                  new HttpError(
                    502,
                    "Stored PDF object is incomplete or corrupted.",
                    "DOCUMENT_CONTENT_CORRUPT",
                  ),
                );
                return;
              }
              controller.close();
              return;
            }
            if (value.byteLength === 0) continue;
            streamedBytes += value.byteLength;
            if (streamedBytes > expectedSizeBytes || streamedBytes > MAX_FILE_BYTES) {
              await reader.cancel().catch(() => {});
              controller.error(
                new HttpError(
                  502,
                  "Stored PDF object does not match the recorded document size.",
                  "DOCUMENT_CONTENT_MISMATCH",
                ),
              );
              return;
            }
            controller.enqueue(value);
            return;
          }
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

export class ReviewStateConflictError extends HttpError {
  readonly currentDocument: PersistedDocument;

  constructor(message: string, code: string, currentDocument: PersistedDocument) {
    super(409, message, code);
    this.name = "ReviewStateConflictError";
    this.currentDocument = currentDocument;
  }
}

async function fetchDocumentReviewEvents(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  documentId: string,
): Promise<DocumentReviewEvent[]> {
  const rows = await sql.query(
    `SELECT
       e."id",
       e."document_id",
       e."from_review_status",
       e."to_review_status",
       e."created_at",
       COALESCE(NULLIF(btrim(u."name"), ''), 'Workspace owner') AS "actor_name"
     FROM "document_review_events" e
     LEFT JOIN "user" u ON u."id" = e."actor_user_id"
     WHERE e."document_id" = $1::uuid AND e."workspace_id" = $2::uuid
     ORDER BY e."created_at" DESC, e."id" DESC
     LIMIT 50`,
    [documentId, workspaceId],
  );
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    id: String(row["id"]),
    documentId: String(row["document_id"]),
    fromReviewStatus:
      row["from_review_status"] == null
        ? null
        : (String(row["from_review_status"]) as DocumentReviewStatus),
    toReviewStatus: String(row["to_review_status"]) as DocumentReviewStatus,
    actorName: String(row["actor_name"] ?? "Workspace owner"),
    createdAt:
      row["created_at"] instanceof Date
        ? row["created_at"].toISOString()
        : String(row["created_at"]),
  }));
}

export interface ListWorkspaceDocumentsOptions {
  status?: DocumentUploadStatus | undefined;
  reviewStatus?: EffectiveDocumentReviewState | undefined;
  batchId?: string | undefined;
  query?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

const MAX_DOCUMENT_LIST_LIMIT = 200;

export async function listWorkspaceDocuments(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  options?: ListWorkspaceDocumentsOptions,
): Promise<DocumentListResponse> {
  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }
  if (options?.batchId !== undefined && !isUuid(options.batchId)) {
    throw new HttpError(400, "Invalid batch identifier.", "INVALID_BATCH_ID");
  }

  const rawLimit = options?.limit ?? 100;
  const limit = Math.max(1, Math.min(MAX_DOCUMENT_LIST_LIMIT, Math.floor(rawLimit)));
  const offset = Math.max(0, Math.floor(options?.offset ?? 0));
  const uploadStatusFilter = options?.status ?? null;
  const reviewFilter = options?.reviewStatus ?? null;
  const batchIdFilter = options?.batchId ?? null;
  const searchRaw = options?.query?.trim() ?? "";
  const escapedSearch = searchRaw ? `%${searchRaw.replace(/[\\%_]/g, "\\$&")}%` : null;

  try {
    const [countRows, filteredCountRows, rows] = await Promise.all([
      sql.query(
        `SELECT
           COUNT(*)::int AS "total",
           COUNT(*) FILTER (WHERE "status" = 'uploaded')::int AS "uploaded",
           COUNT(*) FILTER (WHERE "status" = 'uploaded' AND "review_status" IS NULL)::int AS "unreviewed",
           COUNT(*) FILTER (WHERE "status" = 'uploaded' AND "review_status" = 'needs_review')::int AS "needs_review",
           COUNT(*) FILTER (WHERE "status" = 'uploaded' AND "review_status" = 'verified')::int AS "verified",
           COUNT(*) FILTER (WHERE "status" = 'uploaded' AND "review_status" = 'duplicate')::int AS "duplicate",
           COUNT(*) FILTER (WHERE "status" = 'uploaded' AND "review_status" = 'rejected')::int AS "rejected",
           COUNT(*) FILTER (WHERE "status" = 'uploaded' AND "review_status" = 'skipped')::int AS "skipped"
         FROM "documents"
         WHERE "workspace_id" = $1::uuid`,
        [workspaceId],
      ),
      sql.query(
        `SELECT COUNT(*)::int AS "filtered_total"
         FROM "documents" d
         INNER JOIN "batches" b
           ON b."id" = d."batch_id" AND b."workspace_id" = d."workspace_id"
         WHERE d."workspace_id" = $1::uuid
           AND ($2::text IS NULL OR d."status" = $2::text)
           AND (
             $3::text IS NULL
             OR ($3::text = 'unreviewed' AND d."status" = 'uploaded' AND d."review_status" IS NULL)
             OR ($3::text <> 'unreviewed' AND d."review_status" = $3::text)
           )
           AND ($4::uuid IS NULL OR d."batch_id" = $4::uuid)
           AND (
             $5::text IS NULL
             OR d."original_filename" ILIKE $5::text ESCAPE '\\'
             OR d."id"::text ILIKE $5::text ESCAPE '\\'
             OR b."name" ILIKE $5::text ESCAPE '\\'
             OR b."id"::text ILIKE $5::text ESCAPE '\\'
           )`,
        [workspaceId, uploadStatusFilter, reviewFilter, batchIdFilter, escapedSearch],
      ),
      sql.query(
        `SELECT
           d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
           d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
           d."upload_started_at", d."status", d."review_status", d."review_version",
           d."review_updated_at", d."page_count", d."error_message",
           d."uploaded_at", d."created_at", d."updated_at",
           b."name" AS "batch_name",
           b."status" AS "batch_status",
           b."finalized_at" AS "batch_finalized_at"
         FROM "documents" d
         INNER JOIN "batches" b
           ON b."id" = d."batch_id" AND b."workspace_id" = d."workspace_id"
         WHERE d."workspace_id" = $1::uuid
           AND ($3::text IS NULL OR d."status" = $3::text)
           AND (
             $4::text IS NULL
             OR ($4::text = 'unreviewed' AND d."status" = 'uploaded' AND d."review_status" IS NULL)
             OR ($4::text <> 'unreviewed' AND d."review_status" = $4::text)
           )
           AND ($5::uuid IS NULL OR d."batch_id" = $5::uuid)
           AND (
             $6::text IS NULL
             OR d."original_filename" ILIKE $6::text ESCAPE '\\'
             OR d."id"::text ILIKE $6::text ESCAPE '\\'
             OR b."name" ILIKE $6::text ESCAPE '\\'
             OR b."id"::text ILIKE $6::text ESCAPE '\\'
           )
         ORDER BY COALESCE(d."uploaded_at", d."created_at") DESC, d."created_at" DESC, d."id" DESC
         LIMIT $2::integer OFFSET $7::integer`,
        [
          workspaceId,
          limit,
          uploadStatusFilter,
          reviewFilter,
          batchIdFilter,
          escapedSearch,
          offset,
        ],
      ),
    ]);

    const cRow = countRows[0] ?? {};
    const counts: WorkspaceDocumentReviewCounts = {
      total: Number(cRow["total"] ?? 0),
      uploaded: Number(cRow["uploaded"] ?? 0),
      unreviewed: Number(cRow["unreviewed"] ?? 0),
      needsReview: Number(cRow["needs_review"] ?? 0),
      verified: Number(cRow["verified"] ?? 0),
      duplicate: Number(cRow["duplicate"] ?? 0),
      rejected: Number(cRow["rejected"] ?? 0),
      skipped: Number(cRow["skipped"] ?? 0),
    };

    const documents: WorkspaceDocumentListItem[] = rows.map((row) => ({
      ...toPublicDocument(mapDocumentRow(row)),
      batchName: String(row["batch_name"]),
      batchStatus: String(row["batch_status"]) as BatchIngestionStatus,
      batchFinalizedAt:
        row["batch_finalized_at"] == null
          ? null
          : row["batch_finalized_at"] instanceof Date
            ? row["batch_finalized_at"].toISOString()
            : String(row["batch_finalized_at"]),
    }));

    const filteredTotal = Number(filteredCountRows[0]?.["filtered_total"] ?? documents.length);
    const hasMore = offset + documents.length < filteredTotal;

    return { documents, counts, filteredTotal, hasMore };
  } catch (error) {
    rethrowDbError("listWorkspaceDocuments", error);
  }
}

/**
 * Atomically validates and records a human review/approval decision on an
 * uploaded workspace document using lock order (`batches -> documents`),
 * server transition matrix enforcement, optimistic concurrency (`review_version`
 * / `expectedReviewStatus`), and `Idempotency-Key` replay protection.
 */
export async function transitionDocumentReviewStatus(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    documentId: string;
    actorUserId: string;
    reviewStatus: DocumentReviewStatus;
    expectedReviewStatus?: DocumentReviewStatus | null | undefined;
    expectedReviewVersion?: number | undefined;
    idempotencyKey?: string | undefined;
  },
): Promise<ReviewDocumentResponse> {
  const {
    workspaceId,
    documentId,
    actorUserId,
    reviewStatus,
    expectedReviewStatus,
    expectedReviewVersion,
    idempotencyKey,
  } = params;

  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }
  if (!actorUserId.trim()) {
    throw new HttpError(401, "Authentication required.", "UNAUTHORIZED");
  }
  if (!isDocumentReviewStatus(reviewStatus)) {
    throw new HttpError(400, "Invalid review status.", "INVALID_REVIEW_STATUS");
  }
  if (
    expectedReviewVersion !== undefined &&
    (!Number.isSafeInteger(expectedReviewVersion) || expectedReviewVersion < 0)
  ) {
    throw new HttpError(400, "Invalid expected review version.", "INVALID_REVIEW_EXPECTATION");
  }

  const hasExpectedStatus = expectedReviewStatus !== undefined;
  const expectedStatusValue = expectedReviewStatus ?? null;
  const requestHash = idempotencyKey
    ? await computeReviewDocumentRequestHash({
        reviewStatus,
        ...(hasExpectedStatus ? { expectedReviewStatus } : {}),
        ...(expectedReviewVersion !== undefined ? { expectedReviewVersion } : {}),
      })
    : null;

  try {
    const rows = await sql.query(
      `WITH batch_lock AS (
         SELECT b."id", b."workspace_id", b."name", b."status", b."finalized_at", b."created_at", b."updated_at"
         FROM "batches" b
         INNER JOIN "documents" d
           ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF b
       ),
       target AS (
         SELECT
           d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
           d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
           d."upload_started_at", d."status", d."review_status", d."review_version",
           d."review_updated_at", d."page_count", d."error_message",
           d."uploaded_at", d."created_at", d."updated_at",
           bl."name" AS "batch_name",
           bl."status" AS "batch_status",
           bl."finalized_at" AS "batch_finalized_at",
           bl."created_at" AS "batch_created_at",
           bl."updated_at" AS "batch_updated_at"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF d
       ),
       existing_idem AS (
         SELECT e."id", e."request_hash"
         FROM "document_review_events" e
         INNER JOIN target t ON t."id" = e."document_id"
         WHERE $8::text IS NOT NULL
           AND e."document_id" = t."id"
           AND e."idempotency_key" = $8::text
         LIMIT 1
       ),
       can_apply AS (
         SELECT t."id", t."workspace_id", t."batch_id", t."review_status" AS "prev_review_status"
         FROM target t
         WHERE NOT EXISTS (SELECT 1 FROM existing_idem)
           AND t."status" = 'uploaded'
           AND ($5::integer IS NULL OR t."review_version" = $5::integer)
           AND (
             $6::boolean = false
             OR ($7::text IS NULL AND t."review_status" IS NULL)
             OR ($7::text IS NOT NULL AND t."review_status" = $7::text)
           )
           AND t."review_status" IS DISTINCT FROM $4::text
           AND (
             t."review_status" IS NULL
             OR (t."review_status" = 'needs_review' AND $4::text IN ('verified', 'duplicate', 'rejected', 'skipped'))
             OR (t."review_status" IN ('verified', 'duplicate', 'rejected', 'skipped') AND $4::text = 'needs_review')
           )
       ),
       updated_doc AS (
         UPDATE "documents" d
         SET
           "review_status" = $4::text,
           "review_version" = d."review_version" + 1,
           "review_updated_at" = clock_timestamp(),
           "updated_at" = clock_timestamp()
         FROM can_apply ca
         WHERE d."id" = ca."id" AND d."workspace_id" = ca."workspace_id"
         RETURNING
           d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
           d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
           d."upload_started_at", d."status", d."review_status", d."review_version",
           d."review_updated_at", d."page_count", d."error_message",
           d."uploaded_at", d."created_at", d."updated_at"
       ),
       inserted_event AS (
         INSERT INTO "document_review_events" (
           "workspace_id", "batch_id", "document_id", "actor_user_id",
           "from_review_status", "to_review_status", "idempotency_key", "request_hash"
         )
         SELECT
           u."workspace_id",
           u."batch_id",
           u."id",
           $3::text,
           ca."prev_review_status",
           $4::text,
           $8::text,
           $9::text
         FROM updated_doc u
         INNER JOIN can_apply ca ON ca."id" = u."id"
         ON CONFLICT ("document_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL
         DO NOTHING
         RETURNING "id"
       )
       SELECT
         t."status" AS "target_status",
         t."review_status" AS "target_review_status",
         t."review_version" AS "target_review_version",
         t."batch_name",
         t."batch_status",
         t."batch_finalized_at",
         t."batch_created_at",
         t."batch_updated_at",
         ei."id" AS "existing_idem_id",
         ei."request_hash" AS "existing_idem_hash",
         (SELECT count(*)::int FROM inserted_event) AS "inserted_event_count",
         COALESCE(u."id", t."id") AS "id",
         COALESCE(u."workspace_id", t."workspace_id") AS "workspace_id",
         COALESCE(u."batch_id", t."batch_id") AS "batch_id",
         COALESCE(u."original_filename", t."original_filename") AS "original_filename",
         COALESCE(u."mime_type", t."mime_type") AS "mime_type",
         COALESCE(u."file_size_bytes", t."file_size_bytes") AS "file_size_bytes",
         COALESCE(u."storage_key", t."storage_key") AS "storage_key",
         COALESCE(u."active_attempt_id", t."active_attempt_id") AS "active_attempt_id",
         COALESCE(u."lease_expires_at", t."lease_expires_at") AS "lease_expires_at",
         COALESCE(u."upload_started_at", t."upload_started_at") AS "upload_started_at",
         COALESCE(u."status", t."status") AS "status",
         CASE WHEN u."id" IS NOT NULL THEN u."review_status" ELSE t."review_status" END AS "review_status",
         COALESCE(u."review_version", t."review_version") AS "review_version",
         CASE WHEN u."id" IS NOT NULL THEN u."review_updated_at" ELSE t."review_updated_at" END AS "review_updated_at",
         COALESCE(u."page_count", t."page_count") AS "page_count",
         CASE WHEN u."id" IS NOT NULL THEN u."error_message" ELSE t."error_message" END AS "error_message",
         COALESCE(u."uploaded_at", t."uploaded_at") AS "uploaded_at",
         COALESCE(u."created_at", t."created_at") AS "created_at",
         COALESCE(u."updated_at", t."updated_at") AS "updated_at",
         u."id" AS "updated_id"
       FROM target t
       LEFT JOIN existing_idem ei ON true
       LEFT JOIN updated_doc u ON u."id" = t."id"`,
      [
        documentId,
        workspaceId,
        actorUserId,
        reviewStatus,
        expectedReviewVersion ?? null,
        hasExpectedStatus,
        expectedStatusValue,
        idempotencyKey ?? null,
        requestHash,
      ],
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
    }

    const doc = mapDocumentRow(row);
    const batch = mapBatchRow({
      id: row["batch_id"],
      workspace_id: row["workspace_id"],
      name: row["batch_name"],
      status: row["batch_status"],
      finalized_at: row["batch_finalized_at"],
      created_at: row["batch_created_at"],
      updated_at: row["batch_updated_at"],
    });
    const publicDoc = toPublicDocument(doc);
    const publicBatch = toPublicBatch(batch);

    if (row["existing_idem_id"]) {
      if (String(row["existing_idem_hash"] ?? "") !== (requestHash ?? "")) {
        throw new HttpError(
          409,
          "This Idempotency-Key has already been used for a different review request.",
          "IDEMPOTENCY_CONFLICT",
        );
      }
      const reviewEvents = await fetchDocumentReviewEvents(sql, workspaceId, documentId);
      return {
        document: publicDoc,
        batch: publicBatch,
        reviewEvents,
        idempotentReplay: true,
        alreadyInState: false,
      };
    }

    if (!row["updated_id"]) {
      if (doc.status !== "uploaded") {
        logLifecycleEvent("info", {
          operation: "review_document",
          outcome: "rejected",
          batchId: doc.batchId,
          documentId: doc.id,
          failureCategory: "not_uploaded",
        });
        throw new HttpError(
          409,
          "Document must finish uploading before a review decision can be recorded.",
          "DOCUMENT_NOT_UPLOADED",
        );
      }

      const prevStatus =
        row["target_review_status"] == null
          ? null
          : (String(row["target_review_status"]) as DocumentReviewStatus);
      const prevVersion = Number(row["target_review_version"] ?? 0);

      const versionMismatch =
        expectedReviewVersion !== undefined && prevVersion !== expectedReviewVersion;
      const statusMismatch =
        expectedReviewStatus !== undefined && prevStatus !== expectedReviewStatus;

      if (versionMismatch || statusMismatch) {
        logLifecycleEvent("info", {
          operation: "review_document",
          outcome: "rejected",
          batchId: doc.batchId,
          documentId: doc.id,
          failureCategory: "conflict",
        });
        throw new ReviewStateConflictError(
          "This document's review state changed in another session. Refresh to see the latest state.",
          "REVIEW_STATE_CONFLICT",
          publicDoc,
        );
      }

      if (prevStatus === reviewStatus) {
        const reviewEvents = await fetchDocumentReviewEvents(sql, workspaceId, documentId);
        return {
          document: publicDoc,
          batch: publicBatch,
          reviewEvents,
          idempotentReplay: true,
          alreadyInState: true,
        };
      }

      if (!isValidDocumentReviewTransition(prevStatus, reviewStatus)) {
        logLifecycleEvent("info", {
          operation: "review_document",
          outcome: "rejected",
          batchId: doc.batchId,
          documentId: doc.id,
          failureCategory: "invalid_transition",
        });
        throw new ReviewStateConflictError(
          "This review transition is not allowed. Return the document to review before choosing a new decision.",
          "INVALID_REVIEW_TRANSITION",
          publicDoc,
        );
      }

      throw new ReviewStateConflictError(
        "Review decision could not be recorded.",
        "REVIEW_STATE_CONFLICT",
        publicDoc,
      );
    }

    const reviewEvents = await fetchDocumentReviewEvents(sql, workspaceId, documentId);
    const prevLabel =
      row["target_review_status"] == null ? "unreviewed" : String(row["target_review_status"]);
    logLifecycleEvent("info", {
      operation: "review_document",
      outcome: "succeeded",
      batchId: doc.batchId,
      documentId: doc.id,
      reason: `${prevLabel}->${reviewStatus}`,
    });

    return {
      document: publicDoc,
      batch: publicBatch,
      reviewEvents,
      idempotentReplay: false,
      alreadyInState: false,
    };
  } catch (error) {
    rethrowDbError("transitionDocumentReviewStatus", error);
  }
}

/**
 * Retrieves workspace-scoped document metadata along with its owning batch.
 * Never exposes B2 credentials, raw storage keys, or unrestricted URLs, and
 * uses the same `404` response for cross-workspace and nonexistent IDs.
 */
export async function getWorkspaceDocumentDetail(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  documentId: string,
): Promise<DocumentDetailResponse> {
  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }

  try {
    const rows = await sql.query(
      `SELECT
         d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
         d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
         d."upload_started_at", d."status", d."review_status", d."review_version",
         d."review_updated_at", d."page_count", d."error_message",
         d."uploaded_at", d."created_at", d."updated_at",
         b."name" AS "batch_name",
         b."status" AS "batch_status",
         b."finalized_at" AS "batch_finalized_at",
         b."created_at" AS "batch_created_at",
         b."updated_at" AS "batch_updated_at"
       FROM "documents" d
       INNER JOIN "batches" b
         ON b."id" = d."batch_id" AND b."workspace_id" = d."workspace_id"
       WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
       LIMIT 1`,
      [documentId, workspaceId],
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
    }

    const doc = mapDocumentRow(row);
    const batch = mapBatchRow({
      id: row["batch_id"],
      workspace_id: row["workspace_id"],
      name: row["batch_name"],
      status: row["batch_status"],
      finalized_at: row["batch_finalized_at"],
      created_at: row["batch_created_at"],
      updated_at: row["batch_updated_at"],
    });
    const reviewEvents = await fetchDocumentReviewEvents(sql, workspaceId, documentId);

    return {
      document: toPublicDocument(doc),
      batch: toPublicBatch(batch),
      reviewEvents,
    };
  } catch (error) {
    rethrowDbError("getWorkspaceDocumentDetail", error);
  }
}

/**
 * Atomically deletes an individual workspace-owned document from an unfinalized
 * batch while persisting any required B2 cleanup obligations in
 * `storage_cleanup_outbox` (`reason = 'document_deleted'`) and recomputing
 * the parent batch status in the same SQL statement.
 */
export async function deleteDocumentInWorkspace(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    documentId: string;
    bucketName: string;
  },
): Promise<DeleteDocumentResponse> {
  const { workspaceId, documentId, bucketName } = params;
  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }

  try {
    const rows = await sql.query(
      `WITH batch_lock AS (
         SELECT b."id", b."workspace_id", b."finalized_at"
         FROM "batches" b
         INNER JOIN "documents" d
           ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF b
       ),
       doc_lock AS (
         SELECT
           d."id",
           d."workspace_id",
           d."batch_id",
           d."status",
           d."storage_key",
           d."active_attempt_id",
           d."lease_expires_at",
           bl."finalized_at" AS "batch_finalized_at"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         WHERE d."id" = $1::uuid AND d."workspace_id" = $2::uuid
         FOR UPDATE OF d
       ),
       can_delete AS (
         SELECT dl."id", dl."workspace_id", dl."batch_id"
         FROM doc_lock dl
         WHERE dl."batch_finalized_at" IS NULL
           AND NOT (
             dl."status" = 'uploading'
             AND (dl."lease_expires_at" IS NULL OR dl."lease_expires_at" > clock_timestamp())
           )
       ),
       doc_keys AS (
         SELECT DISTINCT
           dl."id" AS "document_id",
           dl."workspace_id",
           dl."batch_id",
           k."storage_key"
         FROM doc_lock dl
         INNER JOIN can_delete cd ON cd."id" = dl."id"
         CROSS JOIN LATERAL (
           SELECT dl."storage_key" AS "storage_key"
           WHERE dl."storage_key" IS NOT NULL
           UNION
           SELECT ('gathr/' || dl."workspace_id"::text || '/' || dl."batch_id"::text || '/' || dl."id"::text || '/' || dl."active_attempt_id"::text || '.pdf') AS "storage_key"
           WHERE dl."active_attempt_id" IS NOT NULL
         ) k
       ),
       inserted_outbox AS (
         INSERT INTO "storage_cleanup_outbox" (
           "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
         )
         SELECT
           dk."storage_key",
           NULLIF($3::text, ''),
           dk."workspace_id",
           dk."batch_id",
           dk."document_id",
           'document_deleted'
         FROM doc_keys dk
         ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
         DO NOTHING
         RETURNING "id"
       ),
       deleted_doc AS (
         DELETE FROM "documents" d
         USING can_delete cd
         WHERE d."id" = cd."id"
           AND d."workspace_id" = cd."workspace_id"
           AND (SELECT count(*) FROM inserted_outbox) >= 0
         RETURNING d."id", d."batch_id", d."workspace_id"
       ),
       remaining_counts AS (
         SELECT
           cd."batch_id",
           cd."workspace_id",
           COUNT(d."id") FILTER (WHERE d."id" <> cd."id")::int AS "total_count",
           COUNT(d."id") FILTER (WHERE d."id" <> cd."id" AND d."status" IN ('pending_upload', 'uploading'))::int AS "active_count",
           COUNT(d."id") FILTER (WHERE d."id" <> cd."id" AND d."status" = 'uploaded')::int AS "uploaded_count"
         FROM can_delete cd
         LEFT JOIN "documents" d
           ON d."batch_id" = cd."batch_id" AND d."workspace_id" = cd."workspace_id"
         GROUP BY cd."batch_id", cd."workspace_id"
       ),
       updated_batch AS (
         UPDATE "batches" b
         SET
           "status" = CASE
             WHEN rc."active_count" > 0 THEN 'uploading'
             WHEN rc."total_count" > 0 AND rc."uploaded_count" = rc."total_count" THEN 'uploaded'
             WHEN rc."uploaded_count" > 0 THEN 'partial'
             ELSE 'failed'
           END,
           "updated_at" = clock_timestamp()
         FROM remaining_counts rc
         WHERE b."id" = rc."batch_id"
           AND b."workspace_id" = rc."workspace_id"
           AND (SELECT count(*) FROM deleted_doc) > 0
         RETURNING b."id", b."workspace_id", b."name", b."status", b."finalized_at", b."created_at", b."updated_at"
       )
       SELECT
         dl."id" AS "found_id",
         dl."batch_id" AS "target_batch_id",
         dl."batch_finalized_at",
         dl."status" AS "doc_status",
         dd."id" AS "deleted_id",
         (SELECT count(*)::int FROM doc_keys) AS "required_obligations",
         ub."id" AS "batch_id",
         ub."workspace_id",
         ub."name" AS "batch_name",
         ub."status" AS "batch_status",
         ub."finalized_at" AS "batch_finalized_at_out",
         ub."created_at" AS "batch_created_at",
         ub."updated_at" AS "batch_updated_at"
       FROM doc_lock dl
       LEFT JOIN deleted_doc dd ON dd."id" = dl."id"
       LEFT JOIN updated_batch ub ON ub."id" = dl."batch_id"`,
      [documentId, workspaceId, bucketName.trim()],
    );

    const row = rows[0];
    if (!row || !row["found_id"]) {
      throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
    }

    const batchId = String(row["target_batch_id"]);
    if (!row["deleted_id"]) {
      if (row["batch_finalized_at"] != null) {
        logLifecycleEvent("info", {
          operation: "delete_document",
          outcome: "rejected",
          batchId,
          documentId,
          failureCategory: "batch_finalized",
        });
        throw new HttpError(
          409,
          "This batch has been finalized and its documents can no longer be deleted individually.",
          "BATCH_FINALIZED",
        );
      }
      logLifecycleEvent("info", {
        operation: "delete_document",
        outcome: "rejected",
        batchId,
        documentId,
        failureCategory: "conflict",
      });
      throw new HttpError(
        409,
        "Cancel the active upload before deleting this document.",
        "UPLOAD_IN_PROGRESS",
      );
    }

    const batch = mapBatchRow({
      id: row["batch_id"],
      workspace_id: row["workspace_id"],
      name: row["batch_name"],
      status: row["batch_status"],
      finalized_at: row["batch_finalized_at_out"],
      created_at: row["batch_created_at"],
      updated_at: row["batch_updated_at"],
    });
    const required = Number(row["required_obligations"] ?? 0);

    logLifecycleEvent("info", {
      operation: "delete_document",
      outcome: "succeeded",
      batchId,
      documentId,
      count: required,
      reason: "document_deleted",
    });

    return {
      deleted: true,
      documentId,
      batchId,
      batch: toPublicBatch(batch),
      cleanupJobsQueued: required,
    };
  } catch (error) {
    if (!(error instanceof HttpError)) {
      logLifecycleEvent("error", {
        operation: "delete_document",
        outcome: "failed",
        documentId,
        failureCategory: "outbox_persistence_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    rethrowDbError("deleteDocumentInWorkspace", error);
  }
}

/**
 * Handles GET /api/documents/:id/content — authorized, workspace-scoped private
 * PDF streaming retrieval with strict private/no-store caching headers and
 * stream integrity checks before committing a 200 PDF response.
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
  if (!Number.isSafeInteger(doc.fileSizeBytes) || doc.fileSizeBytes <= 0) {
    throw new HttpError(502, "Document size metadata is invalid.", "DOCUMENT_CONTENT_INVALID");
  }

  const b2 = deps.b2 ?? getB2StorageClient(request);

  let obj;
  try {
    obj = await b2.getObject({
      key: doc.storageKey,
      signal: request.signal,
    });
  } catch (error) {
    if (
      error instanceof B2ObjectNotFoundError ||
      (error instanceof B2StorageError && (error.status === 404 || error.s3Code === "NoSuchKey"))
    ) {
      throw new HttpError(404, "Stored PDF object could not be found.", "DOCUMENT_CONTENT_MISSING");
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not retrieve PDF from object storage.", "STORAGE_UNAVAILABLE");
  }

  if (obj.contentLength === 0) {
    await obj.body.cancel().catch(() => {});
    throw new HttpError(502, "Stored PDF object is empty.", "DOCUMENT_CONTENT_CORRUPT");
  }
  if (obj.contentLength !== null && obj.contentLength !== doc.fileSizeBytes) {
    await obj.body.cancel().catch(() => {});
    throw new HttpError(
      502,
      "Stored PDF object does not match the recorded document size.",
      "DOCUMENT_CONTENT_MISMATCH",
    );
  }

  const normalizedObjMime = normalizeMimeType(obj.contentType);
  if (normalizedObjMime && !ALLOWED_STORAGE_DOWNLOAD_MIMES.has(normalizedObjMime)) {
    await obj.body.cancel().catch(() => {});
    throw new HttpError(
      502,
      "Stored object is not a valid PDF document.",
      "DOCUMENT_CONTENT_INVALID",
    );
  }

  const verifiedStream = await preparePdfDownloadStream(obj.body, doc.fileSizeBytes);

  const downloadParam = url.searchParams.get("download");
  const dispositionParam = url.searchParams.get("disposition");
  const asAttachment = downloadParam === "1" || dispositionParam === "attachment";

  const headers = new Headers({
    "Content-Type": PDF_MIME_TYPE,
    "Content-Disposition": formatContentDisposition(doc.originalFilename, asAttachment),
    "Cache-Control": "private, no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "frame-ancestors 'self'",
    "Content-Length": String(obj.contentLength ?? doc.fileSizeBytes),
  });

  return new Response(verifiedStream, { status: 200, headers });
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
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export type PublicUploadResult = {
  document: PersistedDocument;
  batch: PersistedBatch;
};
