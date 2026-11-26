-- ============================================================================
-- GATHR Migration 004 — Per-user plan (manual assignment until billing exists)
-- Target: PostgreSQL / Neon Serverless
-- Precondition: migration 001 applied ("user"."id" is TEXT)
-- A missing row means the user is on the Free plan, so no backfill is needed.
-- Safe to re-run: CREATE TABLE IF NOT EXISTS. This table was first created by
-- hand in development; this migration brings it under the ledger.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "user_plan" (
  "userId"    TEXT PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "plan"      TEXT NOT NULL DEFAULT 'free' CHECK ("plan" IN ('free', 'pro', 'business')),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedBy" TEXT
);