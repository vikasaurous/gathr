import "@tanstack/react-start/server-only";
import {
  isUuid,
  type BatchIngestionStatus,
  type DocumentReviewStatus,
  type DocumentUploadStatus,
} from "@/lib/gathr/ingestion-types";
import { HttpError } from "./env";
import { resolveSession } from "./auth-session";
import type { SqlClient } from "./sql";

// Status unions come from ingestion-types, which mirrors the database CHECK constraints.
export { isUuid };
export type { BatchIngestionStatus, DocumentReviewStatus, DocumentUploadStatus };

export interface AuthenticatedUser {
  id: string;
  name?: string | null | undefined;
  email?: string | null | undefined;
  emailVerified?: boolean | undefined;
}

export interface AuthenticatedContext {
  user: AuthenticatedUser;
  sessionId: string;
}

export interface WorkspaceRow {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface OwnedBatchRow {
  id: string;
  workspaceId: string;
  name: string;
  status: BatchIngestionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OwnedDocumentRow {
  id: string;
  workspaceId: string;
  batchId: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  storageKey: string | null;
  activeAttemptId: string | null;
  leaseExpiresAt: string | null;
  uploadStartedAt: string | null;
  /** Technical upload lifecycle state. Never means approved or rejected. */
  status: DocumentUploadStatus;
  /** Business review state; null until the document has been uploaded. */
  reviewStatus: DocumentReviewStatus | null;
  pageCount: number | null;
  errorMessage: string | null;
  uploadedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function toNullableIsoString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

export function mapBatchRow(row: Record<string, unknown>): OwnedBatchRow {
  return {
    id: String(row["id"]),
    workspaceId: String(row["workspace_id"]),
    name: String(row["name"]),
    status: String(row["status"]) as BatchIngestionStatus,
    createdAt: toIsoString(row["created_at"]),
    updatedAt: toIsoString(row["updated_at"]),
  };
}

export function mapDocumentRow(row: Record<string, unknown>): OwnedDocumentRow {
  return {
    id: String(row["id"]),
    workspaceId: String(row["workspace_id"]),
    batchId: String(row["batch_id"]),
    originalFilename: String(row["original_filename"]),
    mimeType: String(row["mime_type"]),
    fileSizeBytes: Number(row["file_size_bytes"]),
    storageKey: row["storage_key"] == null ? null : String(row["storage_key"]),
    activeAttemptId: row["active_attempt_id"] == null ? null : String(row["active_attempt_id"]),
    leaseExpiresAt: toNullableIsoString(row["lease_expires_at"]),
    uploadStartedAt: toNullableIsoString(row["upload_started_at"]),
    status: String(row["status"]) as DocumentUploadStatus,
    reviewStatus:
      row["review_status"] == null ? null : (String(row["review_status"]) as DocumentReviewStatus),
    pageCount: row["page_count"] == null ? null : Number(row["page_count"]),
    errorMessage: typeof row["error_message"] === "string" ? row["error_message"] : null,
    uploadedAt: toNullableIsoString(row["uploaded_at"]),
    createdAt: toIsoString(row["created_at"]),
    updatedAt: toIsoString(row["updated_at"]),
  };
}

/**
 * Verifies the Better Auth session from incoming request headers.
 * Never trusts client-provided user or workspace identifiers.
 */
export async function requireSession(request?: Request): Promise<AuthenticatedContext> {
  const session = await resolveSession(request);
  if (!session?.user?.id || !session?.session?.id) {
    throw new HttpError(401, "Authentication required.", "UNAUTHORIZED");
  }
  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
    },
    sessionId: session.session.id,
  };
}

/**
 * Like requireSession, but returns null for signed-out visitors instead of
 * throwing. Use for pages that behave differently when signed in.
 */
export async function getOptionalSession(request?: Request): Promise<AuthenticatedContext | null> {
  try {
    return await requireSession(request);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Enforces strict same-origin protection on custom API mutation routes.
 * Better Auth / TanStack Start serverFn CSRF middleware does not cover raw API handlers.
 */
export function assertSameOrigin(request: Request): void {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite !== null && secFetchSite.trim().toLowerCase() !== "same-origin") {
    throw new HttpError(403, "Cross-origin requests are not allowed.", "FORBIDDEN_ORIGIN");
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    throw new HttpError(400, "Invalid request URL.", "INVALID_REQUEST");
  }

  const originHeader = request.headers.get("origin");
  if (originHeader !== null) {
    if (originHeader === "null") {
      throw new HttpError(403, "Cross-origin requests are not allowed.", "FORBIDDEN_ORIGIN");
    }
    let parsedOrigin: string;
    try {
      parsedOrigin = new URL(originHeader).origin;
    } catch {
      throw new HttpError(403, "Invalid request origin.", "FORBIDDEN_ORIGIN");
    }
    if (parsedOrigin !== expectedOrigin) {
      throw new HttpError(403, "Cross-origin requests are not allowed.", "FORBIDDEN_ORIGIN");
    }
    return;
  }

  const refererHeader = request.headers.get("referer");
  if (refererHeader !== null) {
    let parsedReferer: string;
    try {
      parsedReferer = new URL(refererHeader).origin;
    } catch {
      throw new HttpError(403, "Invalid request referer.", "FORBIDDEN_ORIGIN");
    }
    if (parsedReferer !== expectedOrigin) {
      throw new HttpError(403, "Cross-origin requests are not allowed.", "FORBIDDEN_ORIGIN");
    }
    return;
  }

  throw new HttpError(403, "Same-origin header is required.", "FORBIDDEN_ORIGIN");
}

function isMissingTableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "42P01") return true; // Postgres: undefined_table
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /relation ".*workspaces.*" does not exist/i.test(message);
}

/**
 * Resolves (and lazily provisions) the single workspace owned by the user.
 * Ownership comes only from the authenticated user id, never from the client.
 *
 * - Idempotent and race-safe: concurrent first requests converge on one row
 *   (requires a UNIQUE constraint on workspaces.owner_user_id).
 * - Fails clearly (503) when the workspaces table has not been migrated yet.
 * - Fails closed (500, logged) if the returned row is not owned by the user.
 */
export async function getOrCreateWorkspace(
  sql: Pick<SqlClient, "query">,
  user: AuthenticatedUser,
): Promise<WorkspaceRow> {
  const trimmedName = user.name?.trim();
  const defaultName = trimmedName ? `${trimmedName.slice(0, 80)}'s Workspace` : "My Workspace";

  let rows: Record<string, unknown>[];
  try {
    rows = await sql.query(
      `INSERT INTO "workspaces" ("owner_user_id", "name")
       VALUES ($1, $2)
       ON CONFLICT ("owner_user_id")
       DO UPDATE SET "name" = "workspaces"."name"
       RETURNING "id", "owner_user_id", "name", "created_at", "updated_at"`,
      [user.id, defaultName],
    );
  } catch (error) {
    if (isMissingTableError(error)) {
      console.error("[workspace] workspaces table is missing; run the Phase 2 migrations.");
      throw new HttpError(503, "Workspace storage is not set up.", "WORKSPACE_NOT_CONFIGURED");
    }
    throw error;
  }

  const row = rows[0];
  if (!row) {
    throw new HttpError(500, "Failed to resolve workspace.", "WORKSPACE_ERROR");
  }

  if (String(row["owner_user_id"]) !== user.id) {
    // Never return a workspace that the session user does not own.
    console.error("[workspace] ownership mismatch for resolved workspace", { userId: user.id });
    throw new HttpError(500, "Workspace ownership is invalid.", "WORKSPACE_OWNERSHIP_INVALID");
  }

  return {
    id: String(row["id"]),
    ownerUserId: String(row["owner_user_id"]),
    name: String(row["name"]),
    createdAt: toIsoString(row["created_at"]),
    updatedAt: toIsoString(row["updated_at"]),
  };
}

export interface WorkspaceContext extends AuthenticatedContext {
  workspace: WorkspaceRow;
}

/**
 * The single server-side entry point for "who is calling and which workspace
 * do they own". Every protected data operation should start here and use the
 * returned workspace.id for all ownership checks.
 */
export async function requireWorkspaceContext(
  sql: Pick<SqlClient, "query">,
  request?: Request,
): Promise<WorkspaceContext> {
  const ctx = await requireSession(request);
  const workspace = await getOrCreateWorkspace(sql, ctx.user);
  return { ...ctx, workspace };
}

const CLIENT_WORKSPACE_KEYS = new Set(["workspaceid", "workspace_id", "workspace"]);

/**
 * Rejects client-supplied workspace identifiers. The browser never chooses its
 * workspace; call this on request bodies / query objects of protected routes.
 */
export function rejectClientWorkspaceId(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  for (const key of Object.keys(input)) {
    if (CLIENT_WORKSPACE_KEYS.has(key.toLowerCase())) {
      throw new HttpError(
        400,
        "Workspace cannot be specified by the client.",
        "WORKSPACE_ID_NOT_ALLOWED",
      );
    }
  }
}

export async function requireOwnedBatch(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  batchId: string,
): Promise<OwnedBatchRow> {
  if (!isUuid(batchId)) {
    throw new HttpError(400, "Invalid batch identifier.", "INVALID_BATCH_ID");
  }

  const rows = await sql.query(
    `SELECT "id", "workspace_id", "name", "status", "created_at", "updated_at"
     FROM "batches"
     WHERE "id" = $1 AND "workspace_id" = $2
     LIMIT 1`,
    [batchId, workspaceId],
  );

  const row = rows[0];
  if (!row) {
    throw new HttpError(404, "Batch not found.", "BATCH_NOT_FOUND");
  }

  return mapBatchRow(row);
}

export async function requireOwnedDocument(
  sql: Pick<SqlClient, "query">,
  workspaceId: string,
  documentId: string,
): Promise<OwnedDocumentRow> {
  if (!isUuid(documentId)) {
    throw new HttpError(400, "Invalid document identifier.", "INVALID_DOCUMENT_ID");
  }

  const rows = await sql.query(
    `SELECT "id", "workspace_id", "batch_id", "original_filename", "mime_type",
            "file_size_bytes", "storage_key", "active_attempt_id", "lease_expires_at",
            "upload_started_at", "status", "review_status", "page_count", "error_message",
            "uploaded_at", "created_at", "updated_at"
     FROM "documents"
     WHERE "id" = $1 AND "workspace_id" = $2
     LIMIT 1`,
    [documentId, workspaceId],
  );

  const row = rows[0];
  if (!row) {
    throw new HttpError(404, "Document not found.", "DOCUMENT_NOT_FOUND");
  }

  return mapDocumentRow(row);
}
