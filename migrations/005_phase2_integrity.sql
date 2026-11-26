-- ============================================================================
-- GATHR Migration 005 — Phase 2 integrity hardening
-- Target: PostgreSQL / Neon Serverless
-- Precondition: migrations 002 and 003 applied
-- Adds database-level constraints that migration 002 left to application code:
--   * documents.original_filename must be 1-255 characters (not blank)
--   * storage_cleanup_outbox attempt counters must be sane
-- Safe to re-run: each constraint is added only if it does not exist.
-- If existing rows violate a constraint the migration fails and rolls back
-- completely; fix or remove the offending rows, then run it again.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_documents_original_filename'
      AND conrelid = '"documents"'::regclass
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "ck_documents_original_filename"
      CHECK (char_length(btrim("original_filename")) BETWEEN 1 AND 255);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_storage_cleanup_attempts'
      AND conrelid = '"storage_cleanup_outbox"'::regclass
  ) THEN
    ALTER TABLE "storage_cleanup_outbox" ADD CONSTRAINT "ck_storage_cleanup_attempts"
      CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 100);
  END IF;
END $$;