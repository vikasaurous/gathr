-- ============================================================================
-- GATHR Migration 003 — Add review_status to existing documents table
-- Target: PostgreSQL / Neon Serverless
-- Applies: adds review_status column + constraints to pre-existing documents
-- Precondition: migration 002 applied (documents table exists)
-- Safe to re-run: ADD COLUMN IF NOT EXISTS + conditional DO $$ blocks
-- ============================================================================

-- Add review/approval state column (nullable — NULL until upload is complete)
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "review_status" TEXT NULL;

-- Add constraint: valid review_status values only
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_documents_review_status'
      AND conrelid = '"documents"'::regclass
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "ck_documents_review_status"
      CHECK ("review_status" IS NULL OR "review_status" IN ('needs_review', 'verified', 'duplicate', 'rejected', 'skipped'));
  END IF;
END $$;

-- Add constraint: review_status may only be set on uploaded documents
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_documents_review_requires_upload'
      AND conrelid = '"documents"'::regclass
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "ck_documents_review_requires_upload"
      CHECK ("review_status" IS NULL OR "status" = 'uploaded');
  END IF;
END $$;

-- Index: review queue (uploaded docs needing review, per workspace)
CREATE INDEX IF NOT EXISTS "documents_review_queue_idx"
  ON "documents" ("workspace_id", "review_status", "uploaded_at")
  WHERE "status" = 'uploaded' AND "review_status" = 'needs_review';
