import "@tanstack/react-start/server-only";
import type { SqlClient } from "@/lib/db/neon";
import {
  buildStorageKey,
  deriveBatchName,
  hasPdfExtension,
  isPdfMimeType,
  isUuid,
  MAX_FILE_BYTES,
  MAX_FILES_PER_BATCH,
  normalizeMimeType,
  PDF_MIME_TYPE,
  sanitizeOriginalFilename,
  validateCreateBatchPayload,
  type ClaimUploadResponse,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type FinalizeBatchResponse,
  type PersistedBatch,
  type PersistedBatchSummary,
  type PersistedDocument,
  type WorkspaceSummary,
} from "@/lib/gathr/ingestion-types";
import { type B2Storage, StorageNotFoundError, StorageOperationError } from "@/lib/storage/b2";
import { HttpError } from "./env";
import { enqueueBatchCleanupJobs, enqueueCleanupJob, processCleanupOutbox } from "./cleanup-outbox";
import {
  mapBatchRow,
  mapDocumentRow,
  type OwnedBatchRow,
  type OwnedDocumentRow,
  requireOwnedBatch,
  requireOwnedDocument,
  type WorkspaceRow,
} from "./ownership";
import { preparePdfUploadStream } from "./stream-pdf";

type QueryCapableSql = Pick<SqlClient, "query" | "transaction">;

export function toPublicBatch(batch: OwnedBatchRow): PersistedBatch {
  return {
    id: batch.id,
    name: batch.name,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

export function toPublicDocument(doc: OwnedDocumentRow): PersistedDocument {
  return {
    id: doc.id,
    batchId: doc.batchId,
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    fileSizeBytes: doc.fileSizeBytes,
    status: doc.status,
    pageCount: doc.pageCount,
    errorMessage: doc.errorMessage,
    uploadedAt: doc.uploadedAt,
    createdAt: doc.createdAt,
    activeAttemptId: doc.activeAttemptId,
    leaseExpiresAt: doc.leaseExpiresAt,
  };
}

export function toWorkspaceSummary(ws: WorkspaceRow): WorkspaceSummary {
  return {
    id: ws.id,
    name: ws.name,
  };
}

interface NormalizedPendingDoc {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

function validateCreateBatchInput(rawInput: CreateBatchRequest): {
  batchName: string;
  docs: NormalizedPendingDoc[];
} {
  let validated: CreateBatchRequest;
  try {
    validated = validateCreateBatchPayload(rawInput);
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }
    if (err instanceof Error) {
      if (err.message.includes("50 MB") || err.message.includes("exceeds the 50 MB limit")) {
        throw new HttpError(413, err.message, "PAYLOAD_TOO_LARGE");
      }
      throw new HttpError(400, err.message, "INVALID_PAYLOAD");
    }
    throw new HttpError(400, "Invalid batch creation payload.", "INVALID_PAYLOAD");
  }
  const docs: NormalizedPendingDoc[] = [];
  const filenames: string[] = [];

  for (const file of validated.files) {
    const documentId = crypto.randomUUID();
    filenames.push(file.filename);
    docs.push({
      id: documentId,
      originalFilename: file.filename,
      mimeType: PDF_MIME_TYPE,
      sizeBytes: file.sizeBytes,
    });
  }

  const batchName = deriveBatchName(
    typeof validated.name === "string" ? validated.name : undefined,
    filenames,
  );
  return { batchName, docs };
}

export async function createBatchWithPendingDocuments(params: {
  sql: QueryCapableSql;
  workspace: WorkspaceRow;
  input: CreateBatchRequest;
}): Promise<CreateBatchResponse> {
  const { sql, workspace, input } = params;
  const batchId = crypto.randomUUID();
  const { batchName, docs } = validateCreateBatchInput(input);

  const txResults = await sql.transaction((txn) => [
    txn.query(
      `INSERT INTO "batches" ("id", "workspace_id", "name", "status")
       VALUES ($1, $2, $3, 'uploading')
       RETURNING "id", "workspace_id", "name", "status", "created_at", "updated_at"`,
      [batchId, workspace.id, batchName],
    ),
    ...docs.map((doc) =>
      txn.query(
        `INSERT INTO "documents" (
           "id", "workspace_id", "batch_id", "original_filename",
           "mime_type", "file_size_bytes", "storage_key", "status"
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL, 'pending_upload')
         RETURNING "id", "workspace_id", "batch_id", "original_filename", "mime_type",
                   "file_size_bytes", "storage_key", "status", "page_count",
                   "error_message", "uploaded_at", "created_at", "updated_at"`,
        [doc.id, workspace.id, batchId, doc.originalFilename, doc.mimeType, doc.sizeBytes],
      ),
    ),
  ]);

  const batchRow = txResults[0]?.[0];
  if (!batchRow) {
    throw new HttpError(500, "Failed to create batch record.", "BATCH_CREATE_FAILED");
  }

  const createdDocs: PersistedDocument[] = [];
  for (let i = 1; i < txResults.length; i++) {
    const docRow = txResults[i]?.[0];
    if (!docRow) {
      throw new HttpError(500, "Failed to create document metadata.", "DOC_CREATE_FAILED");
    }
    createdDocs.push(toPublicDocument(mapDocumentRow(docRow)));
  }

  return {
    batch: toPublicBatch(mapBatchRow(batchRow)),
    documents: createdDocs,
  };
}

/**
 * Atomically claims an upload attempt lease on a document.
 *
 * Locking protocol:
 * 1. Acquires FOR KEY SHARE on the parent batch row.
 *    - This conflicts with batch finalization or deletion (FOR UPDATE), but allows
 *      concurrent uploads in the same batch.
 * 2. Checks batch status. If not 'uploading', rejects with 409 Conflict.
 * 3. Atomically sets status = 'uploading', active_attempt_id, and lease_expires_at.
 * 4. Yields attempt-unique candidate key: gathr/{ws}/{batch}/{doc}/{attemptId}.pdf
 */
export async function claimDocumentUpload(params: {
  sql: Pick<SqlClient, "query">;
  workspace: WorkspaceRow;
  documentId: string;
  leaseDurationSeconds?: number | undefined;
}): Promise<ClaimUploadResponse> {
  const { sql, workspace, documentId, leaseDurationSeconds = 120 } = params;
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }

  const attemptId = crypto.randomUUID();

  const resultRows = await sql.query(
    `WITH locked_batch AS (
       SELECT b."id", b."status"
       FROM "batches" b
       WHERE b."id" = (
         SELECT d."batch_id" FROM "documents" d WHERE d."id" = $1 AND d."workspace_id" = $2
       )
       AND b."workspace_id" = $2
       FOR KEY SHARE
     ),
     claimed_doc AS (
       UPDATE "documents" d
       SET "status" = 'uploading',
           "active_attempt_id" = $3,
           "lease_expires_at" = now() + ($4 || ' seconds')::interval,
           "upload_started_at" = now(),
           "updated_at" = now()
       FROM locked_batch b
       WHERE d."id" = $1 AND d."workspace_id" = $2
         AND b."status" = 'uploading'
         AND (
           d."status" IN ('pending_upload', 'failed')
           OR (d."status" = 'uploading' AND d."lease_expires_at" < now())
         )
       RETURNING d."id", d."batch_id", d."workspace_id", d."active_attempt_id", d."lease_expires_at"
     )
     SELECT
       (SELECT "status" FROM locked_batch) AS "batch_status",
       c."id" AS "document_id",
       c."batch_id",
       c."workspace_id",
       c."active_attempt_id",
       c."lease_expires_at"
     FROM (SELECT 1) dummy
     LEFT JOIN claimed_doc c ON true`,
    [documentId, workspace.id, attemptId, leaseDurationSeconds],
  );

  const row = resultRows[0];
  if (!row || row["batch_status"] == null) {
    throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
  }

  const batchStatus = String(row["batch_status"]);
  if (batchStatus !== "uploading") {
    throw new HttpError(
      409,
      "Cannot claim document in a finalized batch.",
      "BATCH_ALREADY_FINALIZED",
    );
  }

  if (!row["document_id"]) {
    throw new HttpError(
      409,
      "Document upload is already in progress or has already been completed.",
      "UPLOAD_CLAIM_CONFLICT",
    );
  }

  const candidateStorageKey = buildStorageKey({
    workspaceId: workspace.id,
    batchId: String(row["batch_id"]),
    documentId,
    attemptId,
  });

  return {
    documentId,
    attemptId,
    storageKey: candidateStorageKey,
    leaseExpiresAt: new Date(String(row["lease_expires_at"])).toISOString(),
  };
}

/**
 * Renews an active upload lease via client heartbeat.
 * Prevents premature expiration during slow 50 MB uploads.
 * Enforces an absolute 15-minute maximum lifetime to prevent indefinite stalls.
 */
export async function renewDocumentLease(params: {
  sql: Pick<SqlClient, "query">;
  workspace: WorkspaceRow;
  documentId: string;
  attemptId: string;
  leaseDurationSeconds?: number | undefined;
}): Promise<{ renewed: boolean; leaseExpiresAt: string }> {
  const { sql, workspace, documentId, attemptId, leaseDurationSeconds = 120 } = params;
  if (!isUuid(documentId) || !isUuid(attemptId)) {
    throw new HttpError(400, "Invalid document or attempt identifier.", "INVALID_ID");
  }

  const rows = await sql.query(
    `UPDATE "documents"
     SET "lease_expires_at" = now() + ($1 || ' seconds')::interval,
         "updated_at" = now()
     WHERE "id" = $2 AND "workspace_id" = $3
       AND "status" = 'uploading'
       AND "active_attempt_id" = $4
       AND "lease_expires_at" > now()
       AND "upload_started_at" > (now() - INTERVAL '15 minutes')
     RETURNING "id", "lease_expires_at"`,
    [leaseDurationSeconds, documentId, workspace.id, attemptId],
  );

  const row = rows[0];
  if (!row) {
    throw new HttpError(
      409,
      "Upload lease has expired or this attempt was superseded.",
      "LEASE_EXPIRED",
    );
  }

  return {
    renewed: true,
    leaseExpiresAt: new Date(String(row["lease_expires_at"])).toISOString(),
  };
}

async function markAttemptFailed(params: {
  sql: Pick<SqlClient, "query">;
  workspaceId: string;
  documentId: string;
  attemptId: string;
  reason: string;
}): Promise<void> {
  const { sql, workspaceId, documentId, attemptId, reason } = params;
  try {
    await sql.query(
      `UPDATE "documents"
       SET "status" = 'failed',
           "error_message" = $1,
           "updated_at" = now()
       WHERE "id" = $2 AND "workspace_id" = $3
         AND "status" = 'uploading'
         AND "active_attempt_id" = $4`,
      [reason.slice(0, 500), documentId, workspaceId, attemptId],
    );
  } catch (err) {
    console.error(`[ingestion] Failed to mark attempt failed for ${documentId}:`, err);
  }
}

export async function uploadDocumentContent(params: {
  sql: Pick<SqlClient, "query">;
  getStorage: () => B2Storage;
  workspace: WorkspaceRow;
  documentId: string;
  request: Request;
  providedAttemptId?: string | undefined;
}): Promise<{ document: PersistedDocument }> {
  const { sql, getStorage, workspace, documentId, request, providedAttemptId } = params;
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }

  // 1. Claim or verify the upload attempt
  let activeAttemptId: string;
  let candidateStorageKey: string;
  let expectedFileSize: number;

  if (providedAttemptId && isUuid(providedAttemptId)) {
    // Verify provided attempt token
    const doc = await requireOwnedDocument(sql, workspace.id, documentId);
    if (doc.status !== "uploading" || doc.activeAttemptId !== providedAttemptId) {
      throw new HttpError(
        409,
        "Upload attempt is not active or has been replaced.",
        "ATTEMPT_NOT_ACTIVE",
      );
    }
    if (doc.leaseExpiresAt && new Date(doc.leaseExpiresAt).getTime() <= Date.now()) {
      throw new HttpError(409, "Upload lease has expired.", "LEASE_EXPIRED");
    }
    activeAttemptId = providedAttemptId;
    candidateStorageKey = buildStorageKey({
      workspaceId: workspace.id,
      batchId: doc.batchId,
      documentId: doc.id,
      attemptId: activeAttemptId,
    });
    expectedFileSize = doc.fileSizeBytes;
  } else {
    // Atomically claim a new attempt token under FOR KEY SHARE parent batch lock
    const claim = await claimDocumentUpload({
      sql,
      workspace,
      documentId,
    });
    const doc = await requireOwnedDocument(sql, workspace.id, documentId);
    activeAttemptId = claim.attemptId;
    candidateStorageKey = claim.storageKey;
    expectedFileSize = doc.fileSizeBytes;
  }

  // 2. Validate request headers
  if (!isPdfMimeType(request.headers.get("content-type"))) {
    await markAttemptFailed({
      sql,
      workspaceId: workspace.id,
      documentId,
      attemptId: activeAttemptId,
      reason: "Unsupported media type. Only application/pdf files are allowed.",
    });
    throw new HttpError(415, "Only application/pdf uploads are accepted.", "INVALID_MIME_TYPE");
  }

  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength !== null) {
    const trimmedLength = rawContentLength.trim();
    if (!/^\d+$/.test(trimmedLength)) {
      await markAttemptFailed({
        sql,
        workspaceId: workspace.id,
        documentId,
        attemptId: activeAttemptId,
        reason: "Invalid Content-Length header.",
      });
      throw new HttpError(400, "Invalid Content-Length header.", "INVALID_CONTENT_LENGTH");
    }
    const headerBytes = Number(trimmedLength);
    if (headerBytes <= 0) {
      await markAttemptFailed({
        sql,
        workspaceId: workspace.id,
        documentId,
        attemptId: activeAttemptId,
        reason: "Uploaded file is empty.",
      });
      throw new HttpError(400, "Uploaded file is empty.", "EMPTY_FILE");
    }
    if (headerBytes > MAX_FILE_BYTES) {
      await markAttemptFailed({
        sql,
        workspaceId: workspace.id,
        documentId,
        attemptId: activeAttemptId,
        reason: "Uploaded file exceeds the 50 MB limit.",
      });
      throw new HttpError(413, "Uploaded file exceeds the 50 MB limit.", "FILE_TOO_LARGE");
    }
    if (headerBytes !== expectedFileSize) {
      await markAttemptFailed({
        sql,
        workspaceId: workspace.id,
        documentId,
        attemptId: activeAttemptId,
        reason: "Declared file size does not match upload Content-Length.",
      });
      throw new HttpError(
        400,
        "Declared file size does not match upload Content-Length.",
        "SIZE_MISMATCH",
      );
    }
  }

  // 3. Prepare streaming with cancellation and magic-byte validation
  let prepared: Awaited<ReturnType<typeof preparePdfUploadStream>>;
  try {
    prepared = await preparePdfUploadStream({
      body: request.body,
      expectedSize: expectedFileSize,
      maxSize: MAX_FILE_BYTES,
      incomingSignal: request.signal,
    });
  } catch (err) {
    const msg = err instanceof HttpError ? err.message : "Invalid PDF upload stream.";
    await markAttemptFailed({
      sql,
      workspaceId: workspace.id,
      documentId,
      attemptId: activeAttemptId,
      reason: msg,
    });
    throw err;
  }

  // 4. Resolve storage client
  let storage: B2Storage;
  try {
    storage = getStorage();
  } catch (err) {
    await markAttemptFailed({
      sql,
      workspaceId: workspace.id,
      documentId,
      attemptId: activeAttemptId,
      reason: "Document storage service is unavailable.",
    });
    throw err;
  }

  // 5. Upload to B2 using the attempt-specific isolated storage key
  let putSucceeded = false;
  try {
    await storage.putPdfObject({
      key: candidateStorageKey,
      body: prepared.stream,
      contentLength: expectedFileSize,
      abortSignal: prepared.abortSignal,
    });
    putSucceeded = true;

    await prepared.waitForCompletion();
    const streamState = prepared.getState();
    if (streamState.error) {
      throw streamState.error;
    }
    if (streamState.bytesRead !== expectedFileSize) {
      throw new HttpError(400, "Uploaded file size does not match declared size.", "SIZE_MISMATCH");
    }
  } catch (err) {
    const streamError = prepared.getState().error;
    const effectiveErr = streamError ?? err;

    // Enqueue candidate key for cleanup if any bytes reached storage
    if (putSucceeded) {
      await enqueueCleanupJob(sql, {
        storageKey: candidateStorageKey,
        bucketName: storage.bucketName,
        workspaceId: workspace.id,
        documentId,
        reason: "upload_failed",
      });
    }

    if (effectiveErr instanceof HttpError) {
      await markAttemptFailed({
        sql,
        workspaceId: workspace.id,
        documentId,
        attemptId: activeAttemptId,
        reason: effectiveErr.message,
      });
      throw effectiveErr;
    }

    const errorCode =
      effectiveErr instanceof StorageOperationError
        ? effectiveErr.errorCode
        : "STORAGE_UPLOAD_FAILED";
    console.error(`[b2-upload] Failed to upload document ${documentId}: ${errorCode}`);

    await markAttemptFailed({
      sql,
      workspaceId: workspace.id,
      documentId,
      attemptId: activeAttemptId,
      reason: "Failed to store PDF in document storage.",
    });
    throw new HttpError(502, "Failed to store PDF document.", "STORAGE_UPLOAD_FAILED");
  }

  // 6. Commit the active attempt atomically to PostgreSQL
  try {
    const updatedRows = await sql.query(
      `UPDATE "documents"
       SET "status" = 'uploaded',
           "storage_key" = $1,
           "uploaded_at" = now(),
           "updated_at" = now(),
           "error_message" = NULL,
           "active_attempt_id" = NULL,
           "lease_expires_at" = NULL
       WHERE "id" = $2 AND "workspace_id" = $3
         AND "status" = 'uploading'
         AND "active_attempt_id" = $4
         AND "lease_expires_at" > now()
       RETURNING "id", "workspace_id", "batch_id", "original_filename", "mime_type",
                 "file_size_bytes", "storage_key", "status", "page_count",
                 "error_message", "uploaded_at", "created_at", "updated_at"`,
      [candidateStorageKey, documentId, workspace.id, activeAttemptId],
    );

    const updatedRow = updatedRows[0];
    if (!updatedRow) {
      // The lease expired or a newer attempt was registered!
      // Enqueue this attempt's candidate key to the cleanup outbox so it does not linger.
      await enqueueCleanupJob(sql, {
        storageKey: candidateStorageKey,
        bucketName: storage.bucketName,
        workspaceId: workspace.id,
        documentId,
        reason: "orphaned_attempt",
      });
      throw new HttpError(
        409,
        "Upload attempt expired or was superseded before commitment.",
        "UPLOAD_ATTEMPT_EXPIRED",
      );
    }

    return {
      document: toPublicDocument(mapDocumentRow(updatedRow)),
    };
  } catch (dbErr) {
    if (dbErr instanceof HttpError) throw dbErr;
    console.error(
      `[ingestion] Failed to update metadata for document ${documentId} after upload:`,
      dbErr,
    );
    // Queue attempt key for deletion
    await enqueueCleanupJob(sql, {
      storageKey: candidateStorageKey,
      bucketName: storage.bucketName,
      workspaceId: workspace.id,
      documentId,
      reason: "orphaned_attempt",
    });
    throw new HttpError(
      500,
      "Document could not be finalized after storage upload.",
      "METADATA_UPDATE_FAILED",
    );
  }
}

/**
 * Atomically finalizes a batch with full locking and CTE visibility fix.
 *
 * Protocol:
 * 1. Locks parent batch row with FOR UPDATE.
 * 2. Checks if batch is already finalized (handles concurrent finalization safely).
 * 3. Inspects for active unexpired upload leases. If any exist, aborts with 409 Conflict.
 * 4. Updates all non-terminal documents (pending_upload or expired uploading -> failed).
 * 5. Uses CTE RETURNING output to aggregate document counts, completely bypassing
 *    PostgreSQL statement snapshot visibility bugs.
 * 6. Updates batch status to 'uploaded', 'partial', or 'failed'.
 */
export async function finalizeBatch(params: {
  sql: Pick<SqlClient, "query">;
  workspace: WorkspaceRow;
  batchId: string;
}): Promise<FinalizeBatchResponse> {
  const { sql, workspace, batchId } = params;
  if (!isUuid(batchId)) {
    throw new HttpError(400, "Invalid batch identifier.", "INVALID_BATCH_ID");
  }

  const batchResults = await sql.query(
    `WITH locked_batch AS (
       SELECT "id", "status"
       FROM "batches"
       WHERE "id" = $1 AND "workspace_id" = $2
       FOR UPDATE
     ),
     active_uploads AS (
       SELECT "id"
       FROM "documents"
       WHERE "batch_id" = $1 AND "workspace_id" = $2
         AND "status" = 'uploading' AND "lease_expires_at" > now()
       LIMIT 1
     ),
     finalized_docs AS (
       UPDATE "documents"
       SET "status" = CASE
             WHEN "status" = 'pending_upload' THEN 'failed'
             WHEN "status" = 'uploading' AND "lease_expires_at" <= now() THEN 'failed'
             ELSE "status"
           END,
           "error_message" = CASE
             WHEN "status" = 'pending_upload' AND "error_message" IS NULL THEN 'Upload did not complete.'
             WHEN "status" = 'uploading' AND "lease_expires_at" <= now() AND "error_message" IS NULL THEN 'Upload lease expired.'
             ELSE "error_message"
           END,
           "updated_at" = now()
       WHERE "batch_id" = $1 AND "workspace_id" = $2
         AND EXISTS (SELECT 1 FROM locked_batch WHERE "status" = 'uploading')
         AND NOT EXISTS (SELECT 1 FROM active_uploads)
       RETURNING "id", "status"
     ),
     batch_summary AS (
       SELECT
         COUNT(*)::int AS "total_count",
         COUNT(*) FILTER (WHERE "status" = 'uploaded')::int AS "uploaded_count",
         COUNT(*) FILTER (WHERE "status" = 'failed')::int AS "failed_count"
       FROM finalized_docs
     ),
     updated_batch AS (
       UPDATE "batches" b
       SET "status" = CASE
             WHEN s."total_count" = 0 THEN 'failed'
             WHEN s."uploaded_count" = s."total_count" THEN 'uploaded'
             WHEN s."uploaded_count" > 0 THEN 'partial'
             ELSE 'failed'
           END,
           "updated_at" = now()
       FROM batch_summary s
       WHERE b."id" = $1 AND b."workspace_id" = $2
         AND EXISTS (SELECT 1 FROM locked_batch WHERE "status" = 'uploading')
         AND NOT EXISTS (SELECT 1 FROM active_uploads)
       RETURNING b."id", b."workspace_id", b."name", b."status", b."created_at", b."updated_at"
     )
     SELECT
       (SELECT "status" FROM locked_batch) AS "initial_batch_status",
       (SELECT COUNT(*)::int FROM active_uploads) AS "active_upload_count",
       ub."id",
       ub."workspace_id",
       ub."name",
       ub."status",
       ub."created_at",
       ub."updated_at",
       (SELECT "total_count" FROM batch_summary) AS "total_count",
       (SELECT "uploaded_count" FROM batch_summary) AS "uploaded_count",
       (SELECT "failed_count" FROM batch_summary) AS "failed_count"
     FROM (SELECT 1) dummy
     LEFT JOIN updated_batch ub ON true`,
    [batchId, workspace.id],
  );

  const row = batchResults[0];
  if (!row || row["initial_batch_status"] == null) {
    throw new HttpError(404, "Batch not found.", "BATCH_NOT_FOUND");
  }

  const initialStatus = String(row["initial_batch_status"]);
  const activeUploadCount = Number(row["active_upload_count"] ?? 0);

  // If there are active uploads holding valid leases, reject finalization
  if (activeUploadCount > 0) {
    throw new HttpError(
      409,
      "Cannot finalize batch while document uploads are actively in progress.",
      "ACTIVE_UPLOADS_IN_PROGRESS",
    );
  }

  // Handle concurrent finalization safely: if batch was already finalized, return current detail
  let batchRow: OwnedBatchRow;
  if (initialStatus !== "uploading") {
    batchRow = await requireOwnedBatch(sql, workspace.id, batchId);
  } else {
    if (!row["id"]) {
      throw new HttpError(500, "Failed to finalize batch.", "FINALIZATION_FAILED");
    }
    batchRow = mapBatchRow(row);
  }

  const docRows = await sql.query(
    `SELECT "id", "workspace_id", "batch_id", "original_filename", "mime_type",
            "file_size_bytes", "storage_key", "active_attempt_id", "lease_expires_at",
            "upload_started_at", "status", "page_count", "error_message",
            "uploaded_at", "created_at", "updated_at"
     FROM "documents"
     WHERE "batch_id" = $1 AND "workspace_id" = $2
     ORDER BY "created_at" ASC, "id" ASC`,
    [batchId, workspace.id],
  );

  return {
    batch: toPublicBatch(batchRow),
    documents: docRows.map((r) => toPublicDocument(mapDocumentRow(r))),
  };
}

export async function retrieveDocumentContent(params: {
  sql: Pick<SqlClient, "query">;
  storage: B2Storage;
  workspace: WorkspaceRow;
  documentId: string;
}): Promise<{
  document: PersistedDocument;
  stream: ReadableStream<Uint8Array>;
  contentLength: number | null;
}> {
  const { sql, storage, workspace, documentId } = params;
  const doc = await requireOwnedDocument(sql, workspace.id, documentId);

  if (doc.status !== "uploaded" || !doc.storageKey) {
    throw new HttpError(404, "Document file is not available.", "DOCUMENT_NOT_UPLOADED");
  }

  try {
    const object = await storage.getPdfObject({ key: doc.storageKey });
    return {
      document: toPublicDocument(doc),
      stream: object.stream,
      contentLength: object.contentLength ?? doc.fileSizeBytes,
    };
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      throw new HttpError(404, "Document file was not found in storage.", "OBJECT_NOT_FOUND");
    }
    const errorCode = err instanceof StorageOperationError ? err.errorCode : "STORAGE_READ_FAILED";
    console.error(`[b2-read] Failed to retrieve document ${doc.id}: ${errorCode}`);
    throw new HttpError(502, "Unable to retrieve document.", "STORAGE_READ_FAILED");
  }
}

export async function listWorkspaceBatches(params: {
  sql: Pick<SqlClient, "query">;
  workspace: WorkspaceRow;
}): Promise<PersistedBatchSummary[]> {
  const { sql, workspace } = params;
  const rows = await sql.query(
    `SELECT
       b."id",
       b."workspace_id",
       b."name",
       b."status",
       b."created_at",
       b."updated_at",
       COUNT(d."id")::int AS "document_count",
       COUNT(d."id") FILTER (WHERE d."status" = 'uploaded')::int AS "uploaded_count",
       COUNT(d."id") FILTER (WHERE d."status" = 'failed')::int AS "failed_count",
       COALESCE(SUM(d."file_size_bytes"), 0)::bigint AS "total_size_bytes"
     FROM "batches" b
     LEFT JOIN "documents" d
       ON d."batch_id" = b."id" AND d."workspace_id" = b."workspace_id"
     WHERE b."workspace_id" = $1
     GROUP BY b."id", b."workspace_id", b."name", b."status", b."created_at", b."updated_at"
     ORDER BY b."created_at" DESC`,
    [workspace.id],
  );

  return rows.map((row) => ({
    ...toPublicBatch(mapBatchRow(row)),
    documentCount: Number(row["document_count"] ?? 0),
    uploadedCount: Number(row["uploaded_count"] ?? 0),
    failedCount: Number(row["failed_count"] ?? 0),
    totalSizeBytes: Number(row["total_size_bytes"] ?? 0),
  }));
}

export async function getOwnedBatchDetail(params: {
  sql: Pick<SqlClient, "query">;
  workspace: WorkspaceRow;
  batchId: string;
}): Promise<{ batch: PersistedBatch; documents: PersistedDocument[] }> {
  const { sql, workspace, batchId } = params;
  const batch = await requireOwnedBatch(sql, workspace.id, batchId);

  const docRows = await sql.query(
    `SELECT "id", "workspace_id", "batch_id", "original_filename", "mime_type",
            "file_size_bytes", "storage_key", "active_attempt_id", "lease_expires_at",
            "upload_started_at", "status", "page_count", "error_message",
            "uploaded_at", "created_at", "updated_at"
     FROM "documents"
     WHERE "batch_id" = $1 AND "workspace_id" = $2
     ORDER BY "created_at" ASC, "id" ASC`,
    [batch.id, workspace.id],
  );

  return {
    batch: toPublicBatch(batch),
    documents: docRows.map((row) => toPublicDocument(mapDocumentRow(row))),
  };
}

/**
 * Deletes a batch safely and durably:
 * 1. Queries all non-null storage keys in the batch.
 * 2. Enqueues cleanup obligations and deletes parent batch metadata in ONE atomic database transaction.
 *    Aborts deletion if any cleanup obligation cannot be persisted.
 *    Correctly handles already-existing pending/processing cleanup jobs without conflicts.
 *    Does not swallow database failures.
 *    Preserves outbox records independently of parent metadata cascade.
 * 3. Runs an immediate best-effort cleanup dispatch pass if storage is provided.
 */
export async function deleteOwnedBatch(params: {
  sql: QueryCapableSql;
  getStorage?: (() => B2Storage) | undefined;
  workspace: WorkspaceRow;
  batchId: string;
}): Promise<void> {
  const { sql, getStorage, workspace, batchId } = params;
  const batch = await requireOwnedBatch(sql, workspace.id, batchId);

  // Resolve storage early so we can use the configured bucket name throughout.
  const storage = getStorage
    ? (() => {
        try {
          return getStorage();
        } catch {
          return null;
        }
      })()
    : null;
  const bucketName = storage?.bucketName ?? "gathr-documents";

  const docRows = await sql.query(
    `SELECT "id", "storage_key", "status"
     FROM "documents"
     WHERE "batch_id" = $1 AND "workspace_id" = $2 AND "storage_key" IS NOT NULL`,
    [batch.id, workspace.id],
  );

  const cleanupJobs = docRows
    .filter((r) => r["storage_key"])
    .map((r) => ({
      storageKey: String(r["storage_key"]),
      bucketName,
      workspaceId: workspace.id,
      batchId: batch.id,
      documentId: String(r["id"]),
      reason: "batch_deleted" as const,
    }));

  // 2. Perform cleanup-job persistence and batch deletion in ONE atomic database transaction.
  // If any query fails, the entire transaction is rolled back and the failure is NOT swallowed.
  if (typeof (sql as { transaction?: unknown }).transaction === "function") {
    const txResults = await sql.transaction((txn) => [
      ...cleanupJobs.map((job) =>
        txn.query(
          `INSERT INTO "storage_cleanup_outbox" (
             "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason", "status"
           )
           SELECT $1, $2, $3, $4, $5, $6, 'pending'
           WHERE NOT EXISTS (
             SELECT 1 FROM "storage_cleanup_outbox"
             WHERE "storage_key" = $1 AND "status" IN ('pending', 'processing')
           )
           RETURNING "id"`,
          [
            job.storageKey,
            job.bucketName,
            job.workspaceId,
            job.batchId,
            job.documentId,
            job.reason,
          ],
        ),
      ),
      txn.query(`DELETE FROM "batches" WHERE "id" = $1 AND "workspace_id" = $2 RETURNING "id"`, [
        batch.id,
        workspace.id,
      ]),
    ]);

    const deleteRow = txResults[txResults.length - 1]?.[0];
    if (!deleteRow) {
      throw new HttpError(404, "Batch not found.", "BATCH_NOT_FOUND");
    }
  } else {
    // Single-statement atomic CTE fallback when sql.transaction is not available
    const cteResult = await sql.query(
      `WITH target_docs AS (
         SELECT "id", "storage_key", "workspace_id", "batch_id"
         FROM "documents"
         WHERE "batch_id" = $1 AND "workspace_id" = $2 AND "storage_key" IS NOT NULL
       ),
       enqueued_cleanup AS (
         INSERT INTO "storage_cleanup_outbox" (
           "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason", "status"
         )
         SELECT
           d."storage_key",
           $3,
           d."workspace_id",
           d."batch_id",
           d."id",
           'batch_deleted',
           'pending'
         FROM target_docs d
         WHERE NOT EXISTS (
           SELECT 1 FROM "storage_cleanup_outbox" o
           WHERE o."storage_key" = d."storage_key" AND o."status" IN ('pending', 'processing')
         )
         RETURNING "id"
       ),
       deleted_batch AS (
         DELETE FROM "batches"
         WHERE "id" = $1 AND "workspace_id" = $2
         RETURNING "id"
       )
       SELECT (SELECT "id" FROM deleted_batch) AS "deleted_batch_id"`,
      [batch.id, workspace.id, bucketName],
    );

    if (!cteResult[0]?.["deleted_batch_id"]) {
      throw new HttpError(404, "Batch not found.", "BATCH_NOT_FOUND");
    }
  }

  // 3. Trigger immediate best-effort processing pass if storage is available
  if (storage) {
    try {
      await processCleanupOutbox({ sql, storage, batchSize: Math.max(10, cleanupJobs.length) });
    } catch (cleanupErr) {
      console.warn("[delete-batch] Immediate cleanup sweep deferred to outbox worker:", cleanupErr);
    }
  }
}

export async function updateWorkspaceName(params: {
  sql: Pick<SqlClient, "query">;
  workspace: WorkspaceRow;
  name: string;
}): Promise<WorkspaceSummary> {
  const { sql, workspace, name } = params;
  const trimmed = name.trim().slice(0, 120);
  if (!trimmed) {
    throw new HttpError(400, "Workspace name cannot be empty.", "INVALID_WORKSPACE_NAME");
  }

  const rows = await sql.query(
    `UPDATE "workspaces"
     SET "name" = $1, "updated_at" = now()
     WHERE "id" = $2
     RETURNING "id", "name"`,
    [trimmed, workspace.id],
  );

  const row = rows[0];
  if (!row) {
    throw new HttpError(404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
  }

  return {
    id: String(row["id"]),
    name: String(row["name"]),
  };
}
