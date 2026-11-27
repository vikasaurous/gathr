-- ============================================================================
-- GATHR Migration 008 — Phase 7 document review workflow, concurrency & audit
-- Target: PostgreSQL / Neon Serverless
-- Precondition: migrations 002 and 003 applied (documents.review_status exists)
-- Adds:
--   * documents.review_version INTEGER NOT NULL DEFAULT 0 (optimistic concurrency)
--   * documents.review_updated_at TIMESTAMPTZ NULL (explicit human review timestamp)
--   * ck_documents_review_version & ck_documents_review_updated_requires_upload
--   * documents_workspace_review_list_idx (workspace document & review listing)
--   * document_review_events table (persisted audit trail + per-document idempotency)
-- Safe to re-run: IF NOT EXISTS / pg_constraint guards throughout.
-- ============================================================================

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "review_version"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "review_updated_at" TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_documents_review_version'
      AND conrelid = '"documents"'::regclass
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "ck_documents_review_version"
      CHECK ("review_version" >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_documents_review_updated_requires_upload'
      AND conrelid = '"documents"'::regclass
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "ck_documents_review_updated_requires_upload"
      CHECK ("review_updated_at" IS NULL OR "status" = 'uploaded');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "documents_workspace_review_list_idx"
  ON "documents" ("workspace_id", "status", "review_status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "document_review_events" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"       UUID NOT NULL,
  "batch_id"           UUID NOT NULL,
  "document_id"        UUID NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "actor_user_id"      TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "from_review_status" TEXT NULL,
  "to_review_status"   TEXT NOT NULL,
  "idempotency_key"    TEXT NULL,
  "request_hash"       TEXT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ck_doc_review_events_from"
    CHECK (
      "from_review_status" IS NULL
      OR "from_review_status" IN ('needs_review', 'verified', 'duplicate', 'rejected', 'skipped')
    ),
  CONSTRAINT "ck_doc_review_events_to"
    CHECK ("to_review_status" IN ('needs_review', 'verified', 'duplicate', 'rejected', 'skipped')),
  CONSTRAINT "ck_doc_review_events_idempotency_pair"
    CHECK (
      ("idempotency_key" IS NULL AND "request_hash" IS NULL)
      OR (
        "idempotency_key" IS NOT NULL
        AND "request_hash" IS NOT NULL
        AND char_length("idempotency_key") BETWEEN 1 AND 128
      )
    )
);

CREATE INDEX IF NOT EXISTS "document_review_events_doc_created_idx"
  ON "document_review_events" ("document_id", "created_at" DESC, "id" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "document_review_events_idempotency_idx"
  ON "document_review_events" ("document_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
