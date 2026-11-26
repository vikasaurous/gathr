import "@tanstack/react-start/server-only";
import { isSafeStorageKey, isUuid } from "@/lib/gathr/ingestion-types";
import { B2StorageError, type B2StorageClient } from "./b2-storage";
import { refreshBatchStatus } from "./documents";
import { HttpError } from "./env";
import { logLifecycleEvent, sanitizeDiagnosticDetail } from "./lifecycle-log";
import type { SqlClient } from "./sql";

export const DEFAULT_REAPER_BATCH_SIZE = 50;
export const DEFAULT_OUTBOX_BATCH_SIZE = 25;
export const DEFAULT_OUTBOX_LEASE_SECONDS = 60;
export const DEFAULT_OUTBOX_BASE_RETRY_SECONDS = 30;
export const MAX_OUTBOX_RETRY_SECONDS = 3600;

export type CleanupOutboxReason =
  "orphaned_attempt" | "document_deleted" | "batch_deleted" | "upload_failed" | "reaper_eviction";

export interface CleanupOutboxJobRow {
  id: string;
  storageKey: string;
  bucketName: string;
  workspaceId: string | null;
  batchId: string | null;
  documentId: string | null;
  reason: CleanupOutboxReason;
  status: "pending" | "processing" | "completed" | "dead_letter";
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  workerId: string | null;
  lockedUntil: string | null;
}

export interface StaleReconciliationResult {
  scanned: number;
  reconciled: number;
  failed: number;
  refreshedBatches: number;
}

export interface CleanupWorkerResult {
  workerId: string;
  deadLetteredExpired: number;
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
  staleConflicts: number;
}

function toNullableString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function mapOutboxJob(row: Record<string, unknown>): CleanupOutboxJobRow {
  return {
    id: String(row["id"]),
    storageKey: String(row["storage_key"]),
    bucketName: String(row["bucket_name"]),
    workspaceId: toNullableString(row["workspace_id"]),
    batchId: toNullableString(row["batch_id"]),
    documentId: toNullableString(row["document_id"]),
    reason: String(row["reason"]) as CleanupOutboxReason,
    status: String(row["status"]) as CleanupOutboxJobRow["status"],
    attemptCount: Number(row["attempt_count"] ?? 0),
    maxAttempts: Number(row["max_attempts"] ?? 5),
    lastError: toNullableString(row["last_error"]),
    workerId: toNullableString(row["worker_id"]),
    lockedUntil:
      row["locked_until"] instanceof Date
        ? row["locked_until"].toISOString()
        : toNullableString(row["locked_until"]),
  };
}

/**
 * Persists an orphan storage cleanup obligation directly (even if the parent
 * document or batch row no longer exists). Deduplicated by partial unique index.
 */
export async function recordOrphanStorageKey(
  sql: Pick<SqlClient, "query">,
  params: {
    storageKey: string;
    bucketName: string;
    workspaceId?: string | null | undefined;
    batchId?: string | null | undefined;
    documentId?: string | null | undefined;
    reason?: CleanupOutboxReason | undefined;
  },
): Promise<void> {
  const {
    storageKey,
    bucketName,
    workspaceId = null,
    batchId = null,
    documentId = null,
    reason = "orphaned_attempt",
  } = params;

  if (!isSafeStorageKey(storageKey)) {
    throw new HttpError(400, "Invalid storage key.", "INVALID_STORAGE_KEY");
  }
  if (!bucketName.trim()) {
    throw new HttpError(503, "Object storage bucket is not configured.", "STORAGE_NOT_CONFIGURED");
  }

  await sql.query(
    `INSERT INTO "storage_cleanup_outbox" (
       "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
     )
     VALUES ($1::text, $2::text, $3::uuid, $4::uuid, $5::uuid, $6::text)
     ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
     DO NOTHING`,
    [
      storageKey,
      bucketName.trim(),
      workspaceId && isUuid(workspaceId) ? workspaceId : null,
      batchId && isUuid(batchId) ? batchId : null,
      documentId && isUuid(documentId) ? documentId : null,
      reason,
    ],
  );
}

/**
 * Reconciles expired `uploading` attempts safely:
 * - Acquires locks in canonical order (`batches -> documents`).
 * - Preserves `active_attempt_id` to build and insert the exact attempt key into
 *   `storage_cleanup_outbox` (`reaper_eviction`) in the SAME atomic SQL statement
 *   before clearing active-attempt fields on `documents`.
 * - If outbox insertion fails for a document, the statement rolls back so the
 *   document retains `active_attempt_id` for a later reconciliation pass.
 */
export async function reconcileStaleUploadAttempts(
  sql: Pick<SqlClient, "query">,
  params: {
    bucketName: string;
    limit?: number | undefined;
  },
): Promise<StaleReconciliationResult> {
  const bucketName = params.bucketName.trim();
  if (!bucketName) {
    throw new HttpError(503, "Object storage bucket is not configured.", "STORAGE_NOT_CONFIGURED");
  }
  const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? DEFAULT_REAPER_BATCH_SIZE)));

  const candidates = await sql.query(
    `SELECT "id", "workspace_id", "batch_id", "active_attempt_id"
     FROM "documents"
     WHERE "status" = 'uploading'
       AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= clock_timestamp())
     ORDER BY "lease_expires_at" ASC NULLS FIRST, "id" ASC
     LIMIT $1::integer`,
    [limit],
  );

  let reconciled = 0;
  let failed = 0;
  const affectedBatches = new Map<string, string>();

  for (const candidate of candidates) {
    const documentId = String(candidate["id"]);
    const workspaceId = String(candidate["workspace_id"]);
    const batchId = String(candidate["batch_id"]);
    const candidateAttemptId = toNullableString(candidate["active_attempt_id"]);

    try {
      const rows = await sql.query(
        `WITH batch_lock AS (
           SELECT b."id", b."workspace_id", b."finalized_at"
           FROM "batches" b
           WHERE b."id" = $2::uuid AND b."workspace_id" = $3::uuid
           FOR UPDATE
         ),
         target AS (
           SELECT
             d."id", d."workspace_id", d."batch_id", d."active_attempt_id"
           FROM "documents" d
           INNER JOIN batch_lock bl
             ON bl."id" = d."batch_id" AND bl."workspace_id" = d."workspace_id"
           WHERE d."id" = $1::uuid
             AND d."status" = 'uploading'
             AND (d."lease_expires_at" IS NULL OR d."lease_expires_at" <= clock_timestamp())
           FOR UPDATE OF d SKIP LOCKED
         ),
         outbox_insert AS (
           INSERT INTO "storage_cleanup_outbox" (
             "storage_key", "bucket_name", "workspace_id", "batch_id", "document_id", "reason"
           )
           SELECT
             'gathr/' || t."workspace_id"::text || '/' || t."batch_id"::text || '/' || t."id"::text || '/' || t."active_attempt_id"::text || '.pdf',
             $4::text,
             t."workspace_id",
             t."batch_id",
             t."id",
             'reaper_eviction'
           FROM target t
           WHERE t."active_attempt_id" IS NOT NULL
           ON CONFLICT ("storage_key") WHERE "status" IN ('pending', 'processing')
           DO NOTHING
           RETURNING "id"
         ),
         cleared AS (
           UPDATE "documents" d
           SET
             "status" = 'failed',
             "active_attempt_id" = NULL,
             "lease_expires_at" = NULL,
             "error_message" = 'Upload lease expired before completion.',
             "updated_at" = clock_timestamp()
           FROM target t
           WHERE d."id" = t."id"
             AND d."workspace_id" = t."workspace_id"
             AND (SELECT count(*) FROM outbox_insert) >= 0
           RETURNING d."id", d."batch_id", d."workspace_id", t."active_attempt_id" AS "reconciled_attempt_id"
         )
         SELECT
           c."id" AS "reconciled_id",
           c."batch_id",
           c."workspace_id",
           c."reconciled_attempt_id",
           bl."finalized_at"
         FROM batch_lock bl
         LEFT JOIN cleared c ON c."batch_id" = bl."id"`,
        [documentId, batchId, workspaceId, bucketName],
      );

      const row = rows[0];
      if (row?.["reconciled_id"]) {
        reconciled += 1;
        if (row["finalized_at"] == null) {
          affectedBatches.set(batchId, workspaceId);
        }
        logLifecycleEvent("info", {
          operation: "reconcile_stale_attempt",
          outcome: "succeeded",
          batchId,
          documentId,
          attemptId: toNullableString(row["reconciled_attempt_id"]) ?? candidateAttemptId,
          reason: "reaper_eviction",
        });
      }
    } catch (error) {
      failed += 1;
      logLifecycleEvent("error", {
        operation: "reconcile_stale_attempt",
        outcome: "failed",
        batchId,
        documentId,
        attemptId: candidateAttemptId,
        failureCategory: "outbox_persistence_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [batchId, workspaceId] of affectedBatches) {
    try {
      await refreshBatchStatus(sql, workspaceId, batchId);
    } catch (error) {
      logLifecycleEvent("error", {
        operation: "reconcile_refresh_batch",
        outcome: "failed",
        batchId,
        failureCategory: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scanned: candidates.length,
    reconciled,
    failed,
    refreshedBatches: affectedBatches.size,
  };
}

/**
 * Atomically claims due or lease-expired outbox jobs using `FOR UPDATE SKIP LOCKED`
 * so concurrent cleanup workers never process the same job simultaneously.
 */
export async function claimCleanupOutboxJobs(
  sql: Pick<SqlClient, "query">,
  params?: {
    workerId?: string | undefined;
    limit?: number | undefined;
    leaseSeconds?: number | undefined;
  },
): Promise<{ workerId: string; deadLetteredExpired: number; jobs: CleanupOutboxJobRow[] }> {
  const workerId = params?.workerId?.trim() || globalThis.crypto.randomUUID();
  const limit = Math.max(1, Math.min(200, Math.floor(params?.limit ?? DEFAULT_OUTBOX_BATCH_SIZE)));
  const leaseSeconds = Math.max(
    1,
    Math.min(3600, Math.floor(params?.leaseSeconds ?? DEFAULT_OUTBOX_LEASE_SECONDS)),
  );

  // Move expired processing jobs that already exhausted max_attempts into dead_letter.
  const expiredDeadLetters = await sql.query(
    `UPDATE "storage_cleanup_outbox"
     SET
       "status" = 'dead_letter',
       "worker_id" = NULL,
       "locked_until" = NULL,
       "last_error" = COALESCE("last_error", 'Cleanup worker lease expired after maximum attempts.'),
       "processed_at" = clock_timestamp()
     WHERE "status" = 'processing'
       AND ("locked_until" IS NULL OR "locked_until" <= clock_timestamp())
       AND "attempt_count" >= "max_attempts"
     RETURNING "id", "batch_id", "document_id", "attempt_count", "max_attempts"`,
  );

  for (const dead of expiredDeadLetters) {
    logLifecycleEvent("warn", {
      operation: "cleanup_outbox_dead_letter_expired",
      outcome: "dead_lettered",
      cleanupJobId: String(dead["id"]),
      batchId: toNullableString(dead["batch_id"]),
      documentId: toNullableString(dead["document_id"]),
      attemptCount: Number(dead["attempt_count"] ?? 0),
      maxAttempts: Number(dead["max_attempts"] ?? 0),
      failureCategory: "lease_expired",
    });
  }

  const claimedRows = await sql.query(
    `WITH candidates AS (
       SELECT "id"
       FROM "storage_cleanup_outbox"
       WHERE "attempt_count" < "max_attempts"
         AND (
           ("status" = 'pending' AND "scheduled_at" <= clock_timestamp())
           OR (
             "status" = 'processing'
             AND ("locked_until" IS NULL OR "locked_until" <= clock_timestamp())
           )
         )
       ORDER BY "scheduled_at" ASC, "created_at" ASC, "id" ASC
       LIMIT $1::integer
       FOR UPDATE SKIP LOCKED
     )
     UPDATE "storage_cleanup_outbox" o
     SET
       "status" = 'processing',
       "worker_id" = $2::text,
       "locked_until" = clock_timestamp() + ($3::integer * interval '1 second'),
       "attempt_count" = o."attempt_count" + 1
     FROM candidates c
     WHERE o."id" = c."id"
     RETURNING
       o."id", o."storage_key", o."bucket_name", o."workspace_id", o."batch_id",
       o."document_id", o."reason", o."status", o."attempt_count", o."max_attempts",
       o."last_error", o."worker_id", o."locked_until"`,
    [limit, workerId, leaseSeconds],
  );

  return {
    workerId,
    deadLetteredExpired: expiredDeadLetters.length,
    jobs: claimedRows.map(mapOutboxJob),
  };
}

function computeRetryDelaySeconds(attemptCount: number, baseSeconds: number): number {
  const safeBase = Math.max(1, baseSeconds);
  const exp = Math.min(8, Math.max(0, attemptCount - 1));
  return Math.min(MAX_OUTBOX_RETRY_SECONDS, safeBase * 2 ** exp);
}

function classifyCleanupError(error: unknown): { retryable: boolean; safeError: string } {
  if (error instanceof B2StorageError) {
    return {
      retryable: error.retryable,
      safeError:
        sanitizeDiagnosticDetail(
          `Object storage deletion failed (${error.status}${error.s3Code ? ` ${error.s3Code}` : ""}).`,
        ) ?? "Object storage deletion failed.",
    };
  }
  if (error instanceof HttpError) {
    const retryable = error.status === 408 || error.status === 429 || error.status >= 500;
    return {
      retryable,
      safeError: sanitizeDiagnosticDetail(error.message) ?? "Cleanup request failed.",
    };
  }
  return {
    retryable: true,
    safeError:
      sanitizeDiagnosticDetail(error instanceof Error ? error.message : String(error)) ??
      "Transient storage cleanup failure.",
  };
}

async function markJobCompleted(
  sql: Pick<SqlClient, "query">,
  job: CleanupOutboxJobRow,
  workerId: string,
): Promise<boolean> {
  const rows = await sql.query(
    `UPDATE "storage_cleanup_outbox"
     SET
       "status" = 'completed',
       "worker_id" = NULL,
       "locked_until" = NULL,
       "last_error" = NULL,
       "processed_at" = clock_timestamp()
     WHERE "id" = $1::uuid
       AND "status" = 'processing'
       AND "worker_id" = $2::text
       AND "attempt_count" = $3::integer
     RETURNING "id"`,
    [job.id, workerId, job.attemptCount],
  );
  return rows.length > 0;
}

async function markJobFailed(
  sql: Pick<SqlClient, "query">,
  job: CleanupOutboxJobRow,
  workerId: string,
  params: { retryable: boolean; safeError: string; baseRetrySeconds: number },
): Promise<"retried" | "dead_lettered" | "stale_conflict"> {
  const shouldRetry = params.retryable && job.attemptCount < job.maxAttempts;
  if (shouldRetry) {
    const delaySeconds = computeRetryDelaySeconds(job.attemptCount, params.baseRetrySeconds);
    const rows = await sql.query(
      `UPDATE "storage_cleanup_outbox"
       SET
         "status" = 'pending',
         "worker_id" = NULL,
         "locked_until" = NULL,
         "last_error" = $4::text,
         "scheduled_at" = clock_timestamp() + ($5::integer * interval '1 second')
       WHERE "id" = $1::uuid
         AND "status" = 'processing'
         AND "worker_id" = $2::text
         AND "attempt_count" = $3::integer
       RETURNING "id"`,
      [job.id, workerId, job.attemptCount, params.safeError, delaySeconds],
    );
    return rows.length > 0 ? "retried" : "stale_conflict";
  }

  const rows = await sql.query(
    `UPDATE "storage_cleanup_outbox"
     SET
       "status" = 'dead_letter',
       "worker_id" = NULL,
       "locked_until" = NULL,
       "last_error" = $4::text,
       "processed_at" = clock_timestamp()
     WHERE "id" = $1::uuid
       AND "status" = 'processing'
       AND "worker_id" = $2::text
       AND "attempt_count" = $3::integer
     RETURNING "id"`,
    [job.id, workerId, job.attemptCount, params.safeError],
  );
  return rows.length > 0 ? "dead_lettered" : "stale_conflict";
}

/**
 * Executes a single leased cleanup outbox pass:
 * - Claims exclusive job leases via `FOR UPDATE SKIP LOCKED`.
 * - Verifies object key safety and ensures live canonical document keys are never deleted.
 * - Executes idempotent B2 `deleteObject` (404 counts as completed).
 * - Fences completion/retry/dead-letter updates by `(id, worker_id, attempt_count)`.
 */
export async function processCleanupOutbox(
  sql: Pick<SqlClient, "query">,
  b2: Pick<B2StorageClient, "bucketName" | "deleteObject">,
  options?: {
    workerId?: string | undefined;
    limit?: number | undefined;
    leaseSeconds?: number | undefined;
    baseRetrySeconds?: number | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<CleanupWorkerResult> {
  const { workerId, deadLetteredExpired, jobs } = await claimCleanupOutboxJobs(sql, {
    workerId: options?.workerId,
    limit: options?.limit,
    leaseSeconds: options?.leaseSeconds,
  });

  const baseRetrySeconds = options?.baseRetrySeconds ?? DEFAULT_OUTBOX_BASE_RETRY_SECONDS;
  let completed = 0;
  let retried = 0;
  let deadLettered = deadLetteredExpired;
  let staleConflicts = 0;

  for (const job of jobs) {
    if (options?.signal?.aborted) break;

    if (!isSafeStorageKey(job.storageKey) || job.bucketName !== b2.bucketName) {
      const safeError =
        job.bucketName !== b2.bucketName
          ? "Cleanup job bucket does not match configured B2 bucket."
          : "Cleanup job storage key failed safety validation.";
      const res = await markJobFailed(sql, job, workerId, {
        retryable: false,
        safeError,
        baseRetrySeconds,
      });
      if (res === "dead_lettered") deadLettered += 1;
      else if (res === "stale_conflict") staleConflicts += 1;
      logLifecycleEvent("error", {
        operation: "cleanup_outbox_process",
        outcome: res === "stale_conflict" ? "skipped" : "dead_lettered",
        cleanupJobId: job.id,
        workerId,
        batchId: job.batchId,
        documentId: job.documentId,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        reason: job.reason,
        failureCategory: "validation",
        detail: safeError,
      });
      continue;
    }

    // Defense in depth: never delete an object currently referenced as a live document's canonical key.
    const liveRef = await sql.query(
      `SELECT 1 AS "live"
       FROM "documents"
       WHERE "storage_key" = $1::text
       LIMIT 1`,
      [job.storageKey],
    );
    if (liveRef.length > 0) {
      const safeError = "Refused cleanup: key is currently referenced by a live document record.";
      const res = await markJobFailed(sql, job, workerId, {
        retryable: false,
        safeError,
        baseRetrySeconds,
      });
      if (res === "dead_lettered") deadLettered += 1;
      else if (res === "stale_conflict") staleConflicts += 1;
      logLifecycleEvent("warn", {
        operation: "cleanup_outbox_process",
        outcome: res === "stale_conflict" ? "skipped" : "dead_lettered",
        cleanupJobId: job.id,
        workerId,
        batchId: job.batchId,
        documentId: job.documentId,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        reason: job.reason,
        failureCategory: "live_reference_guard",
      });
      continue;
    }

    try {
      await b2.deleteObject({ key: job.storageKey, signal: options?.signal });
      const updated = await markJobCompleted(sql, job, workerId);
      if (updated) {
        completed += 1;
        logLifecycleEvent("info", {
          operation: "cleanup_outbox_process",
          outcome: "succeeded",
          cleanupJobId: job.id,
          workerId,
          batchId: job.batchId,
          documentId: job.documentId,
          attemptCount: job.attemptCount,
          maxAttempts: job.maxAttempts,
          reason: job.reason,
        });
      } else {
        staleConflicts += 1;
        logLifecycleEvent("warn", {
          operation: "cleanup_outbox_process",
          outcome: "skipped",
          cleanupJobId: job.id,
          workerId,
          batchId: job.batchId,
          documentId: job.documentId,
          attemptCount: job.attemptCount,
          failureCategory: "lease_expired",
        });
      }
    } catch (error) {
      const classified = classifyCleanupError(error);
      const outcome = await markJobFailed(sql, job, workerId, {
        retryable: classified.retryable,
        safeError: classified.safeError,
        baseRetrySeconds,
      });
      if (outcome === "retried") retried += 1;
      else if (outcome === "dead_lettered") deadLettered += 1;
      else staleConflicts += 1;

      logLifecycleEvent(outcome === "dead_lettered" ? "error" : "warn", {
        operation: "cleanup_outbox_process",
        outcome:
          outcome === "retried"
            ? "retried"
            : outcome === "dead_lettered"
              ? "dead_lettered"
              : "skipped",
        cleanupJobId: job.id,
        workerId,
        batchId: job.batchId,
        documentId: job.documentId,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        reason: job.reason,
        failureCategory: "storage_error",
        detail: classified.safeError,
      });
    }
  }

  return {
    workerId,
    deadLetteredExpired,
    claimed: jobs.length,
    completed,
    retried,
    deadLettered,
    staleConflicts,
  };
}
