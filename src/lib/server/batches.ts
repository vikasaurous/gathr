import "@tanstack/react-start/server-only";
import {
  computeCreateBatchRequestHash,
  deriveBatchName,
  disambiguateBatchFilenames,
  type BatchIngestionStatus,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type PersistedBatch,
  type PersistedBatchSummary,
  type PersistedDocument,
} from "@/lib/gathr/ingestion-types";
import { HttpError } from "./env";
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPublicDocument(row: OwnedDocumentRow): PersistedDocument {
  return {
    id: row.id,
    batchId: row.batchId,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSizeBytes,
    status: row.status,
    reviewStatus: row.reviewStatus,
    pageCount: row.pageCount,
    errorMessage: row.errorMessage,
    uploadedAt: row.uploadedAt,
    createdAt: row.createdAt,
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

function mapInsertedJoinRow(row: Record<string, unknown>): {
  batch: OwnedBatchRow;
  document: OwnedDocumentRow;
} {
  const batch: OwnedBatchRow = {
    id: String(row["batch_id"]),
    workspaceId: String(row["workspace_id"]),
    name: String(row["batch_name"]),
    status: String(row["batch_status"]) as BatchIngestionStatus,
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
            "upload_started_at", "status", "review_status", "page_count", "error_message",
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
         RETURNING "id", "workspace_id", "name", "status", "created_at", "updated_at"
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
         RETURNING "id", "workspace_id", "name", "status", "created_at", "updated_at"
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
      `SELECT "id", "workspace_id", "name", "status", "request_hash", "created_at", "updated_at"
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

export async function listWorkspaceBatches(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
): Promise<PersistedBatchSummary[]> {
  try {
    const rows = await sql.query(
      `SELECT
         b."id",
         b."workspace_id",
         b."name",
         b."status",
         b."created_at",
         b."updated_at",
         COUNT(d."id")::int AS "document_count",
         COUNT(d."id") FILTER (WHERE d."status" = 'pending_upload')::int AS "pending_count",
         COUNT(d."id") FILTER (WHERE d."status" = 'uploaded')::int AS "uploaded_count",
         COUNT(d."id") FILTER (WHERE d."status" = 'failed')::int AS "failed_count",
         COALESCE(SUM(d."file_size_bytes"), 0)::bigint AS "total_size_bytes"
       FROM "batches" b
       LEFT JOIN "documents" d
         ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
       WHERE b."workspace_id" = $1::uuid
       GROUP BY b."id"
       ORDER BY b."created_at" DESC
       LIMIT $2`,
      [workspaceId, MAX_BATCH_LIST_LIMIT],
    );

    return rows.map((row) => ({
      ...toPublicBatch(mapBatchRow(row)),
      documentCount: Number(row["document_count"] ?? 0),
      pendingCount: Number(row["pending_count"] ?? 0),
      uploadedCount: Number(row["uploaded_count"] ?? 0),
      failedCount: Number(row["failed_count"] ?? 0),
      totalSizeBytes: Number(row["total_size_bytes"] ?? 0),
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
