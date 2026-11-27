import "@tanstack/react-start/server-only";
import {
  computeBatchFinalStatus,
  computeCreateBatchRequestHash,
  deriveBatchName,
  disambiguateBatchFilenames,
  isUuid,
  isValidBatchTransition,
  type BatchIngestionStatus,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type DeleteBatchResponse,
  type FinalizeBatchResponse,
  type PersistedBatch,
  type PersistedBatchSummary,
  type PersistedDocument,
} from "@/lib/gathr/ingestion-types";
import { HttpError } from "./env";
import { logLifecycleEvent } from "./lifecycle-log";
import {
  mapBatchRow,
  mapDocumentRow,
  requireOwnedBatch,
  type OwnedBatchRow,
  type OwnedDocumentRow,
} from "./ownership";
import type { SqlClient } from "./sql";

const MAX_BATCH_LIST_LIMIT = 100;

export function toPublicBatch(row: OwnedBatchRow): PersistedBatch {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPublicDocument(row: OwnedDocumentRow): PersistedDocument {
  const isUploading = row.status === "uploading";
  return {
    id: row.id,
    batchId: row.batchId,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSizeBytes,
    status: row.status,
    reviewStatus: row.reviewStatus,
    reviewVersion: row.reviewVersion,
    reviewUpdatedAt: row.reviewUpdatedAt,
    pageCount: row.pageCount,
    errorMessage: row.errorMessage,
    uploadedAt: row.uploadedAt,
    createdAt: row.createdAt,
    ...(isUploading && row.activeAttemptId ? { activeAttemptId: row.activeAttemptId } : {}),
    ...(isUploading && row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
  };
}

function isStorageSchemaUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  // 42P01: undefined_table, 42703: undefined_column (e.g., pending migration 006)
  return code === "42P01" || code === "42703";
}

function rethrowStorageError(operation: string, error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (isStorageSchemaUnavailableError(error)) {
    console.error(`[batches] ${operation} blocked: database schema is not fully migrated.`);
    throw new HttpError(503, "Batch storage is not set up.", "STORAGE_NOT_MIGRATED");
  }
  throw error;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function toNullableIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function mapInsertedJoinRow(row: Record<string, unknown>): {
  batch: OwnedBatchRow;
  document: OwnedDocumentRow;
} {
  const batch: OwnedBatchRow = {
    id: String(row["batch_id"]),
    workspaceId: String(row["workspace_id"]),
    name: String(row["batch_name"]),
    status: String(row["batch_status"]) as BatchIngestionStatus,
    finalizedAt: toNullableIso(row["batch_finalized_at"]),
    createdAt: toIso(row["batch_created_at"]),
    updatedAt: toIso(row["batch_updated_at"]),
  };

  const document = mapDocumentRow({
    id: row["doc_id"],
    workspace_id: row["workspace_id"],
    batch_id: row["batch_id"],
    original_filename: row["original_filename"],
    mime_type: row["mime_type"],
    file_size_bytes: row["file_size_bytes"],
    storage_key: null,
    active_attempt_id: null,
    lease_expires_at: null,
    upload_started_at: null,
    status: row["doc_status"],
    review_status: row["review_status"],
    review_version: row["review_version"] ?? 0,
    review_updated_at: row["review_updated_at"] ?? null,
    page_count: row["page_count"],
    error_message: row["error_message"],
    uploaded_at: row["uploaded_at"],
    created_at: row["doc_created_at"],
    updated_at: row["doc_updated_at"],
  });

  return { batch, document };
}

async function fetchBatchDocuments(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  batchId: string,
): Promise<PersistedDocument[]> {
  const rows = await sql.query(
    `SELECT "id", "workspace_id", "batch_id", "original_filename", "mime_type",
            "file_size_bytes", "storage_key", "active_attempt_id", "lease_expires_at",
            "upload_started_at", "status", "review_status", "review_version",
            "review_updated_at", "page_count", "error_message",
            "uploaded_at", "created_at", "updated_at"
     FROM "documents"
     WHERE "batch_id" = $1::uuid AND "workspace_id" = $2::uuid
     ORDER BY "created_at" ASC, "id" ASC`,
    [batchId, workspaceId],
  );
  return rows.map((row) => toPublicDocument(mapDocumentRow(row)));
}

/**
 * Atomically persists a batch and its separate pending_upload document records
 * in PostgreSQL using a single CTE transaction. When `idempotencyKey` is
 * supplied, concurrent or repeated identical submissions return the original
 * persisted batch instead of creating duplicates, while mismatched payloads
 * fail with 409 Conflict.
 */
export async function createBatchInWorkspace(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  payload: CreateBatchRequest,
  idempotencyKey?: string,
): Promise<CreateBatchResponse> {
  const filenames = disambiguateBatchFilenames(payload.files.map((f) => f.filename));
  const batchName = deriveBatchName(payload.name, filenames);
  const sizes = payload.files.map((f) => f.sizeBytes);
  const requestHash = idempotencyKey ? await computeCreateBatchRequestHash(payload) : null;

  const insertSql = idempotencyKey
    ? `WITH inserted_batch AS (
         INSERT INTO "batches" ("workspace_id", "name", "status", "idempotency_key", "request_hash")
         VALUES ($1::uuid, $2::text, 'uploading', $3::text, $4::text)
         ON CONFLICT ("workspace_id", "idempotency_key")
         WHERE "idempotency_key" IS NOT NULL
         DO NOTHING
         RETURNING "id", "workspace_id", "name", "status", "finalized_at", "created_at", "updated_at"
       ),
       inserted_docs AS (
         INSERT INTO "documents" (
           "workspace_id",
           "batch_id",
           "original_filename",
           "mime_type",
           "file_size_bytes",
           "status",
           "created_at"
         )
         SELECT
           ib."workspace_id",
           ib."id",
           d."filename",
           'application/pdf',
           d."size_bytes",
           'pending_upload',
           ib."created_at" + ((d."ord" - 1) * interval '1 microsecond')
         FROM inserted_batch ib
         CROSS JOIN unnest($5::text[], $6::bigint[]) WITH ORDINALITY AS d("filename", "size_bytes", "ord")
         RETURNING
           "id", "workspace_id", "batch_id", "original_filename", "mime_type",
           "file_size_bytes", "status", "review_status", "page_count", "error_message",
           "uploaded_at", "created_at", "updated_at"
       )
       SELECT
         ib."id" AS "batch_id",
         ib."workspace_id",
         ib."name" AS "batch_name",
         ib."status" AS "batch_status",
         ib."finalized_at" AS "batch_finalized_at",
         ib."created_at" AS "batch_created_at",
         ib."updated_at" AS "batch_updated_at",
         idocs."id" AS "doc_id",
         idocs."original_filename",
         idocs."mime_type",
         idocs."file_size_bytes",
         idocs."status" AS "doc_status",
         idocs."review_status",
         idocs."page_count",
         idocs."error_message",
         idocs."uploaded_at",
         idocs."created_at" AS "doc_created_at",
         idocs."updated_at" AS "doc_updated_at"
       FROM inserted_batch ib
       INNER JOIN inserted_docs idocs ON idocs."batch_id" = ib."id"
       ORDER BY idocs."created_at" ASC, idocs."id" ASC`
    : `WITH inserted_batch AS (
         INSERT INTO "batches" ("workspace_id", "name", "status")
         VALUES ($1::uuid, $2::text, 'uploading')
         RETURNING "id", "workspace_id", "name", "status", "finalized_at", "created_at", "updated_at"
       ),
       inserted_docs AS (
         INSERT INTO "documents" (
           "workspace_id",
           "batch_id",
           "original_filename",
           "mime_type",
           "file_size_bytes",
           "status",
           "created_at"
         )
         SELECT
           ib."workspace_id",
           ib."id",
           d."filename",
           'application/pdf',
           d."size_bytes",
           'pending_upload',
           ib."created_at" + ((d."ord" - 1) * interval '1 microsecond')
         FROM inserted_batch ib
         CROSS JOIN unnest($3::text[], $4::bigint[]) WITH ORDINALITY AS d("filename", "size_bytes", "ord")
         RETURNING
           "id", "workspace_id", "batch_id", "original_filename", "mime_type",
           "file_size_bytes", "status", "review_status", "page_count", "error_message",
           "uploaded_at", "created_at", "updated_at"
       )
       SELECT
         ib."id" AS "batch_id",
         ib."workspace_id",
         ib."name" AS "batch_name",
         ib."status" AS "batch_status",
         ib."finalized_at" AS "batch_finalized_at",
         ib."created_at" AS "batch_created_at",
         ib."updated_at" AS "batch_updated_at",
         idocs."id" AS "doc_id",
         idocs."original_filename",
         idocs."mime_type",
         idocs."file_size_bytes",
         idocs."status" AS "doc_status",
         idocs."review_status",
         idocs."page_count",
         idocs."error_message",
         idocs."uploaded_at",
         idocs."created_at" AS "doc_created_at",
         idocs."updated_at" AS "doc_updated_at"
       FROM inserted_batch ib
       INNER JOIN inserted_docs idocs ON idocs."batch_id" = ib."id"
       ORDER BY idocs."created_at" ASC, idocs."id" ASC`;

  const insertParams = idempotencyKey
    ? [workspaceId, batchName, idempotencyKey, requestHash, filenames, sizes]
    : [workspaceId, batchName, filenames, sizes];

  try {
    const rows = await sql.query(insertSql, insertParams);
    if (rows.length > 0) {
      const mapped = rows.map(mapInsertedJoinRow);
      return {
        batch: toPublicBatch(mapped[0]!.batch),
        documents: mapped.map((m) => toPublicDocument(m.document)),
        idempotentReplay: false,
      };
    }

    if (!idempotencyKey) {
      throw new HttpError(500, "Failed to create batch.", "BATCH_CREATE_FAILED");
    }

    // Fresh SELECT takes a new Read Committed snapshot after the winning concurrent
    // CTE committed both batches and documents.
    const existingRows = await sql.query(
      `SELECT "id", "workspace_id", "name", "status", "request_hash", "finalized_at", "created_at", "updated_at"
       FROM "batches"
       WHERE "workspace_id" = $1::uuid AND "idempotency_key" = $2::text
       LIMIT 1`,
      [workspaceId, idempotencyKey],
    );
    const existing = existingRows[0];
    if (!existing) {
      throw new HttpError(
        409,
        "A batch request with this Idempotency-Key could not be resolved. Please retry with a new key.",
        "IDEMPOTENCY_CONFLICT",
      );
    }

    if (String(existing["request_hash"] ?? "") !== requestHash) {
      throw new HttpError(
        409,
        "This Idempotency-Key has already been used for a different batch submission.",
        "IDEMPOTENCY_CONFLICT",
      );
    }

    const batch = mapBatchRow(existing);
    const documents = await fetchBatchDocuments(sql, workspaceId, batch.id);
    return {
      batch: toPublicBatch(batch),
      documents,
      idempotentReplay: true,
    };
  } catch (error) {
    rethrowStorageError("createBatchInWorkspace", error);
  }
}

export interface ListWorkspaceBatchesOptions {
  status?: BatchIngestionStatus | undefined;
  query?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listWorkspaceBatches(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  options?: ListWorkspaceBatchesOptions,
): Promise<PersistedBatchSummary[]> {
  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }

  const rawLimit = options?.limit ?? MAX_BATCH_LIST_LIMIT;
  const limit = Math.max(1, Math.min(MAX_BATCH_LIST_LIMIT, Math.floor(rawLimit)));
  const offset = Math.max(0, Math.floor(options?.offset ?? 0));
  const statusFilter = options?.status ?? null;
  const searchRaw = options?.query?.trim() ?? "";
  const escapedSearch = searchRaw ? `%${searchRaw.replace(/[\\%_]/g, "\\$&")}%` : null;

  try {
    const useFilteredQuery = Boolean(statusFilter || escapedSearch || offset > 0);
    const rows = useFilteredQuery
      ? await sql.query(
          `SELECT
             b."id",
             b."workspace_id",
             b."name",
             b."status",
             b."finalized_at",
             b."created_at",
             b."updated_at",
             COUNT(d."id")::int AS "document_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'pending_upload')::int AS "pending_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded')::int AS "uploaded_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'failed')::int AS "failed_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" IS NULL)::int AS "unreviewed_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'needs_review')::int AS "needs_review_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'verified')::int AS "verified_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'duplicate')::int AS "duplicate_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'rejected')::int AS "rejected_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'skipped')::int AS "skipped_count",
             COALESCE(SUM(d."file_size_bytes"), 0)::bigint AS "total_size_bytes"
           FROM "batches" b
           LEFT JOIN "documents" d
             ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
           WHERE b."workspace_id" = $1::uuid
             AND ($3::text IS NULL OR b."status" = $3::text)
             AND ($4::text IS NULL OR b."name" ILIKE $4::text ESCAPE '\\' OR b."id"::text ILIKE $4::text ESCAPE '\\')
           GROUP BY b."id"
           ORDER BY b."created_at" DESC
           LIMIT $2::integer OFFSET $5::integer`,
          [workspaceId, limit, statusFilter, escapedSearch, offset],
        )
      : await sql.query(
          `SELECT
             b."id",
             b."workspace_id",
             b."name",
             b."status",
             b."finalized_at",
             b."created_at",
             b."updated_at",
             COUNT(d."id")::int AS "document_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'pending_upload')::int AS "pending_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded')::int AS "uploaded_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'failed')::int AS "failed_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" IS NULL)::int AS "unreviewed_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'needs_review')::int AS "needs_review_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'verified')::int AS "verified_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'duplicate')::int AS "duplicate_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'rejected')::int AS "rejected_count",
             COUNT(d."id") FILTER (WHERE d."status" = 'uploaded' AND d."review_status" = 'skipped')::int AS "skipped_count",
             COALESCE(SUM(d."file_size_bytes"), 0)::bigint AS "total_size_bytes"
           FROM "batches" b
           LEFT JOIN "documents" d
             ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
           WHERE b."workspace_id" = $1::uuid
           GROUP BY b."id"
           ORDER BY b."created_at" DESC
           LIMIT $2`,
          [workspaceId, limit],
        );

    return rows.map((row) => ({
      ...toPublicBatch(mapBatchRow(row)),
      documentCount: Number(row["document_count"] ?? 0),
      pendingCount: Number(row["pending_count"] ?? 0),
      uploadedCount: Number(row["uploaded_count"] ?? 0),
      failedCount: Number(row["failed_count"] ?? 0),
      totalSizeBytes: Number(row["total_size_bytes"] ?? 0),
      unreviewedCount: Number(row["unreviewed_count"] ?? 0),
      needsReviewCount: Number(row["needs_review_count"] ?? 0),
      verifiedCount: Number(row["verified_count"] ?? 0),
      duplicateCount: Number(row["duplicate_count"] ?? 0),
      rejectedCount: Number(row["rejected_count"] ?? 0),
      skippedCount: Number(row["skipped_count"] ?? 0),
    }));
  } catch (error) {
    rethrowStorageError("listWorkspaceBatches", error);
  }
}

export async function getWorkspaceBatchDetail(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  batchId: string,
): Promise<{ batch: PersistedBatch; documents: PersistedDocument[] }> {
  try {
    const batch = await requireOwnedBatch(sql, workspaceId, batchId);
    const documents = await fetchBatchDocuments(sql, workspaceId, batch.id);
    return {
      batch: toPublicBatch(batch),
      documents,
    };
  } catch (error) {
    rethrowStorageError("getWorkspaceBatchDetail", error);
  }
}

/**
 * Seals a workspace-owned batch against any further upload claims or retries.
 * Acquires locks in canonical order (`batches -> documents`), refuses when
 * active unexpired upload leases exist (without failing them), reconciles any
 * expired leases atomically with outbox recording, and computes final batch
 * status (`uploaded` | `partial` | `failed`).
 */
export async function finalizeBatchInWorkspace(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    batchId: string;
    bucketName: string;
    allowIncomplete?: boolean | undefined;
  },
): Promise<FinalizeBatchResponse> {
  const { workspaceId, batchId, bucketName, allowIncomplete = false } = params;
  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }
  if (!isUuid(batchId)) {
    throw new HttpError(400, "Invalid batch identifier.", "INVALID_BATCH_ID");
  }

  try {
    const rows = await sql.query(
      `WITH batch_lock AS (
         SELECT "id", "workspace_id", "name", "status", "finalized_at", "created_at", "updated_at"
         FROM "batches"
         WHERE "id" = $1::uuid AND "workspace_id" = $2::uuid
         FOR UPDATE
       ),
       doc_locks AS (
         SELECT
           d."id", d."workspace_id", d."batch_id", d."status",
           d."active_attempt_id", d."lease_expires_at"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         ORDER BY d."created_at" ASC, d."id" ASC
         FOR UPDATE OF d
       ),
       summary AS (
         SELECT
           COUNT(*)::int AS "total_count",
           COUNT(*) FILTER (
             WHERE "status" = 'uploading'
               AND ("lease_expires_at" IS NULL OR "lease_expires_at" > clock_timestamp())
           )::int AS "active_lease_count",
           COUNT(*) FILTER (WHERE "status" = 'pending_upload')::int AS "pending_count",
           COUNT(*) FILTER (
             WHERE "status" = 'uploading'
               AND "lease_expires_at" IS NOT NULL
               AND "lease_expires_at" <= clock_timestamp()
           )::int AS "expired_count",
           COUNT(*) FILTER (WHERE "status" = 'uploaded')::int AS "uploaded_count"
         FROM doc_locks
       ),
       can_seal AS (
         SELECT
           bl."id",
           bl."workspace_id",
           bl."status" AS "prev_status",
           s."total_count",
           s."active_lease_count",
           s."pending_count",
           s."expired_count",
           s."uploaded_count"
         FROM batch_lock bl
         CROSS JOIN summary s
         WHERE bl."finalized_at" IS NULL
           AND s."active_lease_count" = 0
           AND (s."pending_count" = 0 OR $3::boolean = true)
       ),
       reconcile_outbox AS (
         INSERT INTO "storage_cleanup_outbox" (
           "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
         )
         SELECT
           'gathr/' || dl."workspace_id"::text || '/' || dl."batch_id"::text || '/' || dl."id"::text || '/' || dl."active_attempt_id"::text || '.pdf',
           NULLIF($4::text, ''),
           dl."workspace_id",
           dl."batch_id",
           dl."id",
           'reaper_eviction'
         FROM doc_locks dl
         INNER JOIN can_seal cs ON cs."id" = dl."batch_id"
         WHERE dl."status" = 'uploading'
           AND dl."lease_expires_at" IS NOT NULL
           AND dl."lease_expires_at" <= clock_timestamp()
           AND dl."active_attempt_id" IS NOT NULL
         ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
         DO NOTHING
         RETURNING "id"
       ),
       reconciled_docs AS (
         UPDATE "documents" d
         SET
           "status" = 'failed',
           "active_attempt_id" = NULL,
           "lease_expires_at" = NULL,
           "error_message" = CASE
             WHEN d."status" = 'uploading' THEN 'Upload lease expired before completion.'
             ELSE 'Upload did not complete before batch finalization.'
           END,
           "updated_at" = clock_timestamp()
         FROM doc_locks dl
         INNER JOIN can_seal cs ON cs."id" = dl."batch_id"
         WHERE d."id" = dl."id"
           AND d."workspace_id" = dl."workspace_id"
           AND (SELECT count(*) FROM reconcile_outbox) >= 0
           AND (
             (dl."status" = 'uploading' AND dl."lease_expires_at" IS NOT NULL AND dl."lease_expires_at" <= clock_timestamp())
             OR ($3::boolean = true AND dl."status" = 'pending_upload')
           )
         RETURNING d."id"
       ),
       sealed_batch AS (
         UPDATE "batches" b
         SET
           "status" = CASE
             WHEN cs."total_count" > 0 AND cs."uploaded_count" = cs."total_count" THEN 'uploaded'
             WHEN cs."uploaded_count" > 0 THEN 'partial'
             ELSE 'failed'
           END,
           "finalized_at" = clock_timestamp(),
           "updated_at" = clock_timestamp()
         FROM can_seal cs
         WHERE b."id" = cs."id"
           AND b."workspace_id" = cs."workspace_id"
           AND (SELECT count(*) FROM reconciled_docs) >= 0
         RETURNING b."id", b."workspace_id", b."name", b."status", b."finalized_at", b."created_at", b."updated_at"
       )
       SELECT
         bl."id" AS "found_id",
         bl."status" AS "prev_status",
         bl."finalized_at" AS "prev_finalized_at",
         s."total_count",
         s."uploaded_count",
         s."active_lease_count",
         s."pending_count",
         sb."id" AS "sealed_id",
         COALESCE(sb."workspace_id", bl."workspace_id") AS "workspace_id",
         COALESCE(sb."name", bl."name") AS "name",
         COALESCE(sb."status", bl."status") AS "status",
         COALESCE(sb."finalized_at", bl."finalized_at") AS "finalized_at",
         COALESCE(sb."created_at", bl."created_at") AS "created_at",
         COALESCE(sb."updated_at", bl."updated_at") AS "updated_at"
       FROM batch_lock bl
       CROSS JOIN summary s
       LEFT JOIN sealed_batch sb ON sb."id" = bl."id"`,
      [batchId, workspaceId, allowIncomplete, bucketName.trim()],
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "Batch not found.", "BATCH_NOT_FOUND");
    }

    const alreadyFinalized = row["prev_finalized_at"] != null;
    if (!alreadyFinalized && !row["sealed_id"]) {
      const activeLeases = Number(row["active_lease_count"] ?? 0);
      const pendingCount = Number(row["pending_count"] ?? 0);
      if (activeLeases > 0) {
        logLifecycleEvent("info", {
          operation: "finalize_batch",
          outcome: "rejected",
          batchId,
          failureCategory: "conflict",
          count: activeLeases,
        });
        throw new HttpError(
          409,
          "Cannot finalize batch while document uploads are actively in progress.",
          "UPLOAD_IN_PROGRESS",
        );
      }
      if (pendingCount > 0) {
        logLifecycleEvent("info", {
          operation: "finalize_batch",
          outcome: "rejected",
          batchId,
          failureCategory: "conflict",
          count: pendingCount,
        });
        throw new HttpError(
          409,
          "Some documents in this batch have not finished uploading yet.",
          "BATCH_HAS_UNRESOLVED_DOCUMENTS",
        );
      }
      throw new HttpError(409, "Batch could not be finalized.", "BATCH_FINALIZE_CONFLICT");
    }

    const prevStatus = String(row["prev_status"]) as BatchIngestionStatus;
    const expectedNext = computeBatchFinalStatus(
      Number(row["total_count"] ?? 0),
      Number(row["uploaded_count"] ?? 0),
    );
    if (!alreadyFinalized && !isValidBatchTransition(prevStatus, expectedNext, false)) {
      throw new HttpError(409, "Invalid batch state transition.", "INVALID_BATCH_TRANSITION");
    }

    const batch = mapBatchRow({
      id: row["found_id"],
      workspace_id: row["workspace_id"],
      name: row["name"],
      status: row["status"],
      finalized_at: row["finalized_at"],
      created_at: row["created_at"],
      updated_at: row["updated_at"],
    });
    const documents = await fetchBatchDocuments(sql, workspaceId, batch.id);

    logLifecycleEvent("info", {
      operation: "finalize_batch",
      outcome: "succeeded",
      batchId: batch.id,
      reason: alreadyFinalized ? "already_finalized" : batch.status,
      count: documents.length,
    });

    return {
      batch: toPublicBatch(batch),
      documents,
      alreadyFinalized,
    };
  } catch (error) {
    rethrowStorageError("finalizeBatchInWorkspace", error);
  }
}

/**
 * Atomically deletes a workspace-owned batch and its child documents while
 * persisting all required B2 cleanup obligations in `storage_cleanup_outbox`.
 * If any obligation fails to persist, the entire SQL statement rolls back and
 * batch/document metadata remains intact.
 */
export async function deleteBatchInWorkspace(
  sql: Pick<SqlClient, "query">,
  params: {
    workspaceId: string;
    batchId: string;
    bucketName: string;
  },
): Promise<DeleteBatchResponse> {
  const { workspaceId, batchId, bucketName } = params;
  if (!isUuid(workspaceId)) {
    throw new HttpError(400, "Invalid workspace identifier.", "INVALID_WORKSPACE_ID");
  }
  if (!isUuid(batchId)) {
    throw new HttpError(400, "Invalid batch identifier.", "INVALID_BATCH_ID");
  }

  try {
    const rows = await sql.query(
      `WITH batch_lock AS (
         SELECT "id", "workspace_id"
         FROM "batches"
         WHERE "id" = $1::uuid AND "workspace_id" = $2::uuid
         FOR UPDATE
       ),
       doc_locks AS (
         SELECT
           d."id",
           d."workspace_id",
           d."batch_id",
           d."storage_key",
           d."active_attempt_id"
         FROM "documents" d
         INNER JOIN batch_lock bl
           ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
         ORDER BY d."created_at" ASC, d."id" ASC
         FOR UPDATE OF d
       ),
       doc_keys AS (
         SELECT DISTINCT
           dl."id" AS "document_id",
           dl."workspace_id",
           dl."batch_id",
           k."storage_key"
         FROM doc_locks dl
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
           'batch_deleted'
         FROM doc_keys dk
         ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
         DO NOTHING
         RETURNING "id"
       ),
       deleted_batch AS (
         DELETE FROM "batches" b
         USING batch_lock bl
         WHERE b."id" = bl."id"
           AND b."workspace_id" = bl."workspace_id"
           AND (SELECT count(*) FROM inserted_outbox) >= 0
         RETURNING b."id"
       )
       SELECT
         (SELECT "id" FROM batch_lock) AS "batch_id",
         (SELECT "id" FROM deleted_batch) AS "deleted_id",
         (SELECT count(*)::int FROM doc_keys) AS "required_obligations",
         (SELECT count(*)::int FROM inserted_outbox) AS "inserted_obligations"`,
      [batchId, workspaceId, bucketName.trim()],
    );

    const row = rows[0];
    if (!row || !row["batch_id"] || !row["deleted_id"]) {
      throw new HttpError(404, "Batch not found.", "BATCH_NOT_FOUND");
    }

    const required = Number(row["required_obligations"] ?? 0);
    logLifecycleEvent("info", {
      operation: "delete_batch",
      outcome: "succeeded",
      batchId,
      count: required,
      reason: "batch_deleted",
    });

    return {
      deleted: true,
      batchId,
      cleanupJobsQueued: required,
    };
  } catch (error) {
    if (!(error instanceof HttpError)) {
      logLifecycleEvent("error", {
        operation: "delete_batch",
        outcome: "failed",
        batchId,
        failureCategory: "outbox_persistence_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    rethrowStorageError("deleteBatchInWorkspace", error);
  }
}
