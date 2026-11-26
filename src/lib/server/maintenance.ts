import "@tanstack/react-start/server-only";
import { getB2StorageClient, type B2StorageClient } from "./b2-storage";
import { getServerEnv } from "./env";
import {
  processCleanupOutbox,
  reconcileStaleUploadAttempts,
  type CleanupWorkerResult,
  type StaleReconciliationResult,
} from "./lifecycle";
import { logLifecycleEvent } from "./lifecycle-log";
import { getSql, type SqlClient } from "./sql";

export interface ScheduledMaintenanceResult {
  executed: boolean;
  skippedReason?: string | undefined;
  reconciliation?: StaleReconciliationResult | undefined;
  cleanup?: CleanupWorkerResult | undefined;
}

/**
 * Runs scheduled background lifecycle maintenance:
 * 1) Reconciles expired upload leases while preserving exact attempt keys.
 * 2) Processes due and lease-expired storage cleanup outbox obligations.
 *
 * Invoked exclusively by the Cloudflare Workers scheduled handler, never by
 * public HTTP routes.
 */
export async function runScheduledMaintenance(options?: {
  env?: Record<string, unknown> | undefined;
  sql?: Pick<SqlClient, "query"> | undefined;
  b2?: Pick<B2StorageClient, "bucketName" | "deleteObject"> | undefined;
  reconcileLimit?: number | undefined;
  outboxLimit?: number | undefined;
  outboxLeaseSeconds?: number | undefined;
  cron?: string | undefined;
}): Promise<ScheduledMaintenanceResult> {
  const serverEnv = getServerEnv(undefined, options?.env);
  if (!options?.sql && !serverEnv.DATABASE_URL) {
    logLifecycleEvent("warn", {
      operation: "scheduled_maintenance",
      outcome: "skipped",
      failureCategory: "configuration_missing",
      detail: "DATABASE_URL is not configured.",
    });
    return { executed: false, skippedReason: "DATABASE_URL_MISSING" };
  }

  let b2: Pick<B2StorageClient, "bucketName" | "deleteObject">;
  try {
    b2 = options?.b2 ?? getB2StorageClient(undefined, options?.env);
  } catch (error) {
    logLifecycleEvent("warn", {
      operation: "scheduled_maintenance",
      outcome: "skipped",
      failureCategory: "configuration_missing",
      detail: error instanceof Error ? error.message : "Object storage is not configured.",
    });
    return { executed: false, skippedReason: "STORAGE_NOT_CONFIGURED" };
  }

  const sql = options?.sql ?? getSql(undefined, options?.env);

  const reconciliation = await reconcileStaleUploadAttempts(sql, {
    bucketName: b2.bucketName,
    limit: options?.reconcileLimit,
  });

  const cleanup = await processCleanupOutbox(sql, b2, {
    limit: options?.outboxLimit,
    leaseSeconds: options?.outboxLeaseSeconds,
  });

  logLifecycleEvent("info", {
    operation: "scheduled_maintenance",
    outcome: "succeeded",
    count: reconciliation.reconciled + cleanup.completed,
    detail: `cron=${options?.cron ?? "manual"} reconciled=${reconciliation.reconciled} failedReconcile=${reconciliation.failed} cleanupCompleted=${cleanup.completed} cleanupRetried=${cleanup.retried} cleanupDeadLetter=${cleanup.deadLettered}`,
  });

  return {
    executed: true,
    reconciliation,
    cleanup,
  };
}
