-- ============================================================================
-- GATHR Migration 007 — Phase 5 batch finalization and cleanup lease indexing
-- Target: PostgreSQL / Neon Serverless
-- Precondition: migrations 002, 005, 006 applied
-- Adds:
--   * batches.finalized_at TIMESTAMPTZ NULL (explicit batch sealing timestamp)
--   * ck_batches_finalized_status CHECK (sealed batches cannot stay uploading)
--   * idx_storage_cleanup_processing_lease (expired processing lease recovery)
-- Safe to re-run: IF NOT EXISTS guards throughout.
-- ============================================================================

ALTER TABLE "batches"
  ADD COLUMN IF NOT EXISTS "finalized_at" TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_batches_finalized_status'
      AND conrelid = '"batches"'::regclass
  ) THEN
    ALTER TABLE "batches" ADD CONSTRAINT "ck_batches_finalized_status"
      CHECK ("finalized_at" IS NULL OR "status" IN ('uploaded', 'partial', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_storage_cleanup_processing_lease"
  ON "storage_cleanup_outbox" ("locked_until")
  WHERE "status" = 'processing';
