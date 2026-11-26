-- ============================================================================
-- GATHR Migration 006 — Phase 3 batch creation idempotency
-- Target: PostgreSQL / Neon Serverless
-- Precondition: migration 002 applied (requires "batches" table)
-- Adds workspace-scoped idempotency tracking to batches so double-clicks and
-- repeated POST /api/batches submissions cannot create duplicate batches.
-- Safe to re-run: IF NOT EXISTS guards throughout.
-- ============================================================================

ALTER TABLE "batches"
  ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "request_hash"    TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_batches_idempotency_pair'
      AND conrelid = '"batches"'::regclass
  ) THEN
    ALTER TABLE "batches" ADD CONSTRAINT "ck_batches_idempotency_pair"
      CHECK (
        ("idempotency_key" IS NULL AND "request_hash" IS NULL)
        OR (
          "idempotency_key" IS NOT NULL
          AND "request_hash" IS NOT NULL
          AND char_length("idempotency_key") BETWEEN 1 AND 128
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "batches_workspace_idempotency_key_idx"
  ON "batches" ("workspace_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
