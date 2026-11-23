CREATE TABLE IF NOT EXISTS "user_plan" (
  "userId"    TEXT PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "plan"      TEXT NOT NULL DEFAULT 'free' CHECK ("plan" IN ('free', 'pro', 'business')),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedBy" TEXT
);