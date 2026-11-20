import "@tanstack/react-start/server-only";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "@/lib/auth/server";
import type { SqlClient } from "@/lib/db/neon";
import { HttpError } from "./env";
import {
  isUuid,
  type BatchIngestionStatus,
  type DocumentUploadStatus,
} from "@/lib/gathr/ingestion-types";

export interface AuthenticatedUser {
  id: string;
  name?: string | null | undefined;
  email?: string | null | undefined;
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
  status: DocumentUploadStatus;
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
  const headers = request ? request.headers : getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session?.user?.id || !session?.session?.id) {
    throw new HttpError(401, "Authentication required.", "UNAUTHORIZED");
  }
  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    },
    sessionId: session.session.id,
  };
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

export async function getOrCreateWorkspace(
  sql: Pick<SqlClient, "query">,
  user: AuthenticatedUser,
): Promise<WorkspaceRow> {
  const trimmedName = user.name?.trim();
  const defaultName = trimmedName ? `${trimmedName.slice(0, 80)}'s Workspace` : "My Workspace";

  const rows = await sql.query(
    `INSERT INTO "workspaces" ("owner_user_id", "name")
     VALUES ($1, $2)
     ON CONFLICT ("owner_user_id")
     DO UPDATE SET "name" = "workspaces"."name"
     RETURNING "id", "owner_user_id", "name", "created_at", "updated_at"`,
    [user.id, defaultName],
  );

  const row = rows[0];
  if (!row) {
    throw new HttpError(500, "Failed to resolve workspace.", "WORKSPACE_ERROR");
  }

  return {
    id: String(row["id"]),
    ownerUserId: String(row["owner_user_id"]),
    name: String(row["name"]),
    createdAt: toIsoString(row["created_at"]),
    updatedAt: toIsoString(row["updated_at"]),
  };
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
            "upload_started_at", "status", "page_count", "error_message",
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
