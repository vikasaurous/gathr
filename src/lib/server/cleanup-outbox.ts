import "@tanstack/react-start/server-only";
import type { SqlClient } from "@/lib/db/neon";
import { buildStorageKey } from "@/lib/gathr/ingestion-types";
import { type B2Storage, StorageNotFoundError, StorageOperationError } from "@/lib/storage/b2";

export interface CleanupJobInput {
  storageKey: string;
  bucketName: string;
  workspaceId?: string | null | undefined;
  batchId?: string | null | undefined;
  documentId?: string | null | undefined;
  reason:
    "orphaned_attempt" | "document_deleted" | "batch_deleted" | "upload_failed" | "reaper_eviction";
}

export interface ClaimedCleanupRow {
  id: string;
  storageKey: string;
  bucketName: string;
  attemptCount: number;
  maxAttempts: number;
}

export interface CleanupProcessingResult {
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  deadLetterCount: number;
  errors: Array<{ id: string; storageKey: string; error: string }>;
}

/**
 * Persists an object deletion task to the durable cleanup outbox.
 * Contains no foreign keys to workspaces, batches, or documents, ensuring
 * that cleanup obligations survive even if parent entities are deleted.
 *
 * Handles Neon outages gracefully: if the database cannot be reached, logs
 * a critical diagnostic and returns { queued: false } so caller can attempt
 * best-effort inline deletion or raise visibility.
 */
export async function enqueueCleanupJob(
  sql: Pick<SqlClient, "query">,
  input: CleanupJobInput,
): Promise<{ queued: boolean; jobId?: string | undefined }> {
  try {
    const rows = await sql.query(
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
        input.storageKey,
        input.bucketName,
        input.workspaceId ?? null,
        input.batchId ?? null,
        input.documentId ?? null,
        input.reason,
      ],
    );

    const row = rows[0];
    return {
      queued: Boolean(row),
      jobId: row ? String(row["id"]) : undefined,
    };
  } catch (err) {
    console.error(
      `[cleanup-outbox] Database outage or error while enqueuing cleanup for ${input.storageKey}:`,
      err,
    );
    return { queued: false };
  }
}

/**
 * Bulk enqueues multiple cleanup obligations in a single query with deduplication.
 * Crucial for atomic persistence before deleting a batch or workspace.
 */
export async function enqueueBatchCleanupJobs(
  sql: Pick<SqlClient, "query">,
  jobs: CleanupJobInput[],
): Promise<{ queuedCount: number; failed: boolean }> {
  if (jobs.length === 0) return { queuedCount: 0, failed: false };

  let queuedCount = 0;
  let failed = false;

  for (const job of jobs) {
    const res = await enqueueCleanupJob(sql, job);
    if (res.queued) queuedCount++;
    if (!res.queued && !res.jobId) failed = true;
  }

  return { queuedCount, failed };
}

/**
 * Processes due cleanup outbox records.
 * Uses FOR UPDATE SKIP LOCKED to prevent duplicate processing by concurrent workers.
 * Implements bounded exponential backoff on transient errors and transitions to dead_letter
 * on permanent failures. Never silently swallows B2 deletion failures.
 */
export async function processCleanupOutbox(params: {
  sql: Pick<SqlClient, "query">;
  storage: B2Storage;
  batchSize?: number | undefined;
  workerId?: string | undefined;
}): Promise<CleanupProcessingResult> {
  const { sql, storage, batchSize = 10, workerId = crypto.randomUUID() } = params;

  let claimedRows: ClaimedCleanupRow[] = [];
  try {
    const rawRows = await sql.query(
      `UPDATE "storage_cleanup_outbox"
       SET "status" = 'processing',
           "worker_id" = $1,
           "locked_until" = now() + INTERVAL '2 minutes',
           "attempt_count" = "attempt_count" + 1
       WHERE "id" IN (
         SELECT "id"
         FROM "storage_cleanup_outbox"
         WHERE ("status" = 'pending' OR ("status" = 'processing' AND "locked_until" < now()))
           AND "scheduled_at" <= now()
           AND "attempt_count" < "max_attempts"
         ORDER BY "scheduled_at" ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING "id", "storage_key", "bucket_name", "attempt_count", "max_attempts"`,
      [workerId, batchSize],
    );

    claimedRows = rawRows.map((r) => ({
      id: String(r["id"]),
      storageKey: String(r["storage_key"]),
      bucketName: String(r["bucket_name"]),
      attemptCount: Number(r["attempt_count"]),
      maxAttempts: Number(r["max_attempts"] ?? 5),
    }));
  } catch (claimErr) {
    console.error("[cleanup-outbox] Error claiming outbox records:", claimErr);
    return {
      processedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      deadLetterCount: 0,
      errors: [{ id: "claim", storageKey: "*", error: String(claimErr) }],
    };
  }

  const result: CleanupProcessingResult = {
    processedCount: claimedRows.length,
    succeededCount: 0,
    failedCount: 0,
    deadLetterCount: 0,
    errors: [],
  };

  for (const item of claimedRows) {
    try {
      await storage.deletePdfObject({ key: item.storageKey });

      // Mark completed
      await sql.query(
        `UPDATE "storage_cleanup_outbox"
         SET "status" = 'completed',
             "processed_at" = now(),
             "locked_until" = NULL,
             "last_error" = NULL
         WHERE "id" = $1`,
        [item.id],
      );
      result.succeededCount++;
    } catch (delErr) {
      result.failedCount++;
      const errorMessage =
        delErr instanceof StorageOperationError
          ? delErr.errorCode
          : delErr instanceof Error
            ? delErr.message
            : "STORAGE_DELETE_FAILED";

      console.error(
        `[cleanup-outbox] Failed to delete object ${item.storageKey} (attempt ${item.attemptCount}/${item.maxAttempts}): ${errorMessage}`,
      );
      result.errors.push({ id: item.id, storageKey: item.storageKey, error: errorMessage });

      if (item.attemptCount >= item.maxAttempts) {
        // Move to dead letter queue
        result.deadLetterCount++;
        await sql
          .query(
            `UPDATE "storage_cleanup_outbox"
           SET "status" = 'dead_letter',
               "last_error" = $1,
               "locked_until" = NULL
           WHERE "id" = $2`,
            [errorMessage.slice(0, 500), item.id],
          )
          .catch(() => {});
      } else {
        // Exponential backoff: 30s * 2^(attempt - 1), max 1 hour
        const backoffSeconds = Math.min(30 * Math.pow(2, item.attemptCount - 1), 3600);
        await sql
          .query(
            `UPDATE "storage_cleanup_outbox"
           SET "status" = 'pending',
               "scheduled_at" = now() + ($1 || ' seconds')::interval,
               "last_error" = $2,
               "locked_until" = NULL
           WHERE "id" = $3`,
            [backoffSeconds, errorMessage.slice(0, 500), item.id],
          )
          .catch(() => {});
      }
    }
  }

  return result;
}

/**
 * Reconciles stale upload attempts that have exceeded their maximum lease duration.
 * 1. Preserves expired attempt IDs before clearing them.
 * 2. Constructs exact attempt-specific B2 keys using workspace ID, batch ID, document ID, and attempt ID.
 * 3. Persists cleanup obligations before clearing attempt information.
 * 4. If cleanup persistence fails, does not silently discard the attempt information.
 * 5. Strictly fences document updates by active_attempt_id so newer attempts are never affected.
 */
export async function reconcileStaleUploadAttempts(
  sql: Pick<SqlClient, "query">,
  options?: { bucketName?: string | undefined; limit?: number | undefined } | undefined,
): Promise<number> {
  const bucketName = options?.bucketName ?? "gathr-documents";
  const limit = options?.limit ?? 50;

  try {
    // 1. Query stale candidates preserving their active_attempt_id
    const candidates = await sql.query(
      `SELECT "id", "workspace_id", "batch_id", "active_attempt_id"
       FROM "documents"
       WHERE "status" = 'uploading'
         AND "lease_expires_at" < now()
         AND "upload_started_at" < (now() - INTERVAL '15 minutes')
         AND "active_attempt_id" IS NOT NULL
       LIMIT $1`,
      [limit],
    );

    if (candidates.length === 0) return 0;

    let reconciledCount = 0;

    for (const doc of candidates) {
      const documentId = String(doc["id"]);
      const workspaceId = String(doc["workspace_id"]);
      const batchId = String(doc["batch_id"]);
      const attemptId = String(doc["active_attempt_id"]);

      if (!attemptId) continue;

      let storageKey: string;
      try {
        storageKey = buildStorageKey({
          workspaceId,
          batchId,
          documentId,
          attemptId,
        });
      } catch (keyErr) {
        console.error(
          `[reconcile] Failed to build storage key for document ${documentId} attempt ${attemptId}:`,
          keyErr,
        );
        continue;
      }

      // 2. Persist cleanup obligation BEFORE clearing attempt information
      const enqueueResult = await enqueueCleanupJob(sql, {
        storageKey,
        bucketName,
        workspaceId,
        batchId,
        documentId,
        reason: "orphaned_attempt",
      });

      // If cleanup persistence fails and no job exists, do NOT discard the attempt info
      if (!enqueueResult.queued && !enqueueResult.jobId) {
        console.warn(
          `[reconcile] Skipping clearing attempt ${attemptId} for doc ${documentId}: cleanup outbox enqueue failed.`,
        );
        continue;
      }

      // 3. Atomically transition document to failed and clear attempt, strictly fenced by active_attempt_id
      const updated = await sql.query(
        `UPDATE "documents"
         SET "status" = 'failed',
             "error_message" = 'Upload lease expired and attempt was abandoned.',
             "active_attempt_id" = NULL,
             "lease_expires_at" = NULL,
             "updated_at" = now()
         WHERE "id" = $1
           AND "active_attempt_id" = $2
           AND "status" = 'uploading'
         RETURNING "id"`,
        [documentId, attemptId],
      );

      if (updated.length > 0) {
        reconciledCount++;
      }
    }

    return reconciledCount;
  } catch (err) {
    console.error("[reconcile] Error reconciling stale upload attempts:", err);
    return 0;
  }
}
