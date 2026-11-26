-- ============================================================================
-- GATHR Migration 002 — GATHR Ingestion Schema
-- Target: PostgreSQL / Neon Serverless
-- Applies: workspaces, batches, documents, storage_cleanup_outbox
-- Precondition: migration 001 applied (requires "user"("id") TEXT)
-- Safe to re-run: CREATE TABLE IF NOT EXISTS throughout
-- ============================================================================

-- Step 1: Workspaces
-- owner_user_id is TEXT — matching Better Auth "user"."id" (TEXT PRIMARY KEY)
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_user_id"  TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name"           TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "workspaces_owner_user_id_key" UNIQUE ("owner_user_id")
);

-- Step 2: Batches (scoped to workspace)
CREATE TABLE IF NOT EXISTS "batches" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"  UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name"          TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'uploading',
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "batches_workspace_id_id_key" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "ck_batches_status" CHECK ("status" IN ('uploading', 'uploaded', 'partial', 'failed'))
);

-- Step 3: Documents (scoped to both batch AND workspace via composite FK)
-- The composite FK to batches("workspace_id", "id") ensures a document cannot be
-- attached to a batch from another workspace — the DB enforces this invariant.
CREATE TABLE IF NOT EXISTS "documents" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"       UUID NOT NULL,
  "batch_id"           UUID NOT NULL,
  "original_filename"  TEXT NOT NULL,
  "mime_type"          TEXT NOT NULL DEFAULT 'application/pdf',
  "file_size_bytes"    BIGINT NOT NULL CHECK ("file_size_bytes" > 0 AND "file_size_bytes" <= 52428800),
  "storage_key"        TEXT NULL,
  "active_attempt_id"  UUID NULL,
  "lease_expires_at"   TIMESTAMPTZ NULL,
  "upload_started_at"  TIMESTAMPTZ NULL,
  -- Upload lifecycle state: pending_upload → uploading → uploaded | failed
  -- This is a TECHNICAL state only. It NEVER means approved/rejected.
  "status"             TEXT NOT NULL DEFAULT 'pending_upload',
  -- Business review/approval state: null until upload completes
  -- needs_review → verified | duplicate | rejected | skipped
  "review_status"      TEXT NULL,
  "page_count"         INTEGER CHECK ("page_count" IS NULL OR "page_count" > 0),
  "error_message"      TEXT,
  "uploaded_at"        TIMESTAMPTZ,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Composite FK ensures document workspace matches batch workspace
  CONSTRAINT "documents_workspace_batch_fk"
    FOREIGN KEY ("workspace_id", "batch_id")
    REFERENCES "batches"("workspace_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "ck_documents_mime"
    CHECK ("mime_type" = 'application/pdf'),
  CONSTRAINT "ck_documents_storage_key"
    CHECK ("storage_key" IS NULL OR "storage_key" LIKE 'gathr/%'),
  CONSTRAINT "ck_documents_status"
    CHECK ("status" IN ('pending_upload', 'uploading', 'uploaded', 'failed')),
  CONSTRAINT "ck_documents_review_status"
    CHECK ("review_status" IS NULL OR "review_status" IN ('needs_review', 'verified', 'duplicate', 'rejected', 'skipped')),
  -- Upload status and review status must be consistent:
  -- review_status may only be set once a document is uploaded
  CONSTRAINT "ck_documents_review_requires_upload"
    CHECK ("review_status" IS NULL OR "status" = 'uploaded')
);

-- Step 4: Storage Cleanup Outbox
-- Intentionally NO foreign keys to workspaces/batches/documents.
-- Cleanup obligations must survive deletion of their parent records.
CREATE TABLE IF NOT EXISTS "storage_cleanup_outbox" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storage_key"    TEXT NOT NULL,
  "bucket_name"    TEXT NOT NULL,
  "workspace_id"   UUID NULL,   -- informational only, not an FK
  "batch_id"       UUID NULL,   -- informational only, not an FK
  "document_id"    UUID NULL,   -- informational only, not an FK
  "reason"         TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "attempt_count"  INTEGER NOT NULL DEFAULT 0,
  "max_attempts"   INTEGER NOT NULL DEFAULT 5,
  "last_error"     TEXT NULL,
  "worker_id"      TEXT NULL,
  "locked_until"   TIMESTAMPTZ NULL,
  "scheduled_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processed_at"   TIMESTAMPTZ NULL,
  CONSTRAINT "ck_storage_cleanup_status"
    CHECK ("status" IN ('pending', 'processing', 'completed', 'dead_letter')),
  CONSTRAINT "ck_storage_cleanup_reason"
    CHECK ("reason" IN ('orphaned_attempt', 'document_deleted', 'batch_deleted', 'upload_failed', 'reaper_eviction'))
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Workspace-scoped batch list (most recent first)
CREATE INDEX IF NOT EXISTS "batches_workspace_created_at_idx"
  ON "batches" ("workspace_id", "created_at" DESC);

-- Document list within a batch (chronological)
CREATE INDEX IF NOT EXISTS "documents_batch_created_at_idx"
  ON "documents" ("batch_id", "created_at" ASC);

-- Workspace-scoped document queries (ownership verification)
CREATE INDEX IF NOT EXISTS "documents_workspace_batch_idx"
  ON "documents" ("workspace_id", "batch_id");

-- Unique storage key (one live object per document)
CREATE UNIQUE INDEX IF NOT EXISTS "documents_canonical_storage_key_idx"
  ON "documents" ("storage_key")
  WHERE "storage_key" IS NOT NULL;

-- Active upload lease queries (stale upload reaper)
CREATE INDEX IF NOT EXISTS "documents_active_lease_idx"
  ON "documents" ("status", "lease_expires_at")
  WHERE "status" = 'uploading';

-- Review queue (uploaded docs awaiting review)
CREATE INDEX IF NOT EXISTS "documents_review_queue_idx"
  ON "documents" ("workspace_id", "review_status", "uploaded_at")
  WHERE "status" = 'uploaded' AND "review_status" = 'needs_review';

-- Cleanup outbox dispatch (dequeue pending jobs)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_storage_cleanup_unique_active"
  ON "storage_cleanup_outbox" ("storage_key")
  WHERE "status" IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS "idx_storage_cleanup_dispatch"
  ON "storage_cleanup_outbox" ("scheduled_at", "status")
  WHERE "status" IN ('pending', 'processing');
