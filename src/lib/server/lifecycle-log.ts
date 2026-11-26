import "@tanstack/react-start/server-only";

export type LifecycleLogLevel = "info" | "warn" | "error";

export type LifecycleFailureCategory =
  | "validation"
  | "conflict"
  | "batch_finalized"
  | "lease_expired"
  | "attempt_superseded"
  | "stream_aborted"
  | "storage_error"
  | "database_error"
  | "outbox_persistence_failed"
  | "live_reference_guard"
  | "configuration_missing"
  | "unexpected_error";

export interface LifecycleLogFields {
  operation: string;
  outcome:
    "started" | "succeeded" | "rejected" | "retried" | "dead_lettered" | "failed" | "skipped";
  batchId?: string | null | undefined;
  documentId?: string | null | undefined;
  attemptId?: string | null | undefined;
  cleanupJobId?: string | null | undefined;
  workerId?: string | null | undefined;
  attemptCount?: number | undefined;
  maxAttempts?: number | undefined;
  reason?: string | undefined;
  failureCategory?: LifecycleFailureCategory | undefined;
  count?: number | undefined;
  detail?: string | undefined;
}

const SECRET_OR_KEY_PATTERN =
  /(gathr\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+|postgres(?:ql)?:\/\/\S+|bearer\s+\S+|aws4-hmac-sha256\S*|x-amz-\S+|%PDF-)/gi;

export function sanitizeDiagnosticDetail(raw: unknown, maxLen = 200): string | undefined {
  if (typeof raw !== "string") return undefined;
  const scrubbed = raw.replace(SECRET_OR_KEY_PATTERN, "[redacted]").replace(/\s+/g, " ").trim();
  if (!scrubbed) return undefined;
  return scrubbed.length > maxLen ? `${scrubbed.slice(0, maxLen)}…` : scrubbed;
}

/**
 * Emits structured lifecycle diagnostics without secrets, B2 keys, PDF contents,
 * or raw storage paths.
 */
export function logLifecycleEvent(level: LifecycleLogLevel, fields: LifecycleLogFields): void {
  const payload: Record<string, unknown> = {
    operation: fields.operation,
    outcome: fields.outcome,
  };
  if (fields.batchId) payload["batchId"] = fields.batchId;
  if (fields.documentId) payload["documentId"] = fields.documentId;
  if (fields.attemptId) payload["attemptId"] = fields.attemptId;
  if (fields.cleanupJobId) payload["cleanupJobId"] = fields.cleanupJobId;
  if (fields.workerId) payload["workerId"] = fields.workerId;
  if (fields.attemptCount !== undefined) payload["attemptCount"] = fields.attemptCount;
  if (fields.maxAttempts !== undefined) payload["maxAttempts"] = fields.maxAttempts;
  if (fields.reason) payload["reason"] = fields.reason;
  if (fields.failureCategory) payload["failureCategory"] = fields.failureCategory;
  if (fields.count !== undefined) payload["count"] = fields.count;
  const safeDetail = sanitizeDiagnosticDetail(fields.detail);
  if (safeDetail) payload["detail"] = safeDetail;

  if (level === "error") {
    console.error("[gathr:lifecycle]", payload);
  } else if (level === "warn") {
    console.warn("[gathr:lifecycle]", payload);
  } else {
    console.info("[gathr:lifecycle]", payload);
  }
}
