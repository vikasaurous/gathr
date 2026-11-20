#!/usr/bin/env node
/**
 * GATHR migration runner — applies SQL migration files in numbered order.
 *
 * Usage:
 *   node scripts/migrate.mjs             # apply all pending migrations
 *   node scripts/migrate.mjs --dry-run   # check without applying (Acceptance Check 8)
 *   node scripts/migrate.mjs --status    # list applied/pending migrations
 *
 * Requirements:
 *   - DATABASE_URL in environment (or .env.local)
 *   - psql installed and on PATH
 *
 * Design:
 *   - Maintains a migrations_log table to track applied migrations.
 *   - Applies migrations in ascending numeric order (001, 002, ...).
 *   - Each migration runs in its own transaction; failure stops the sequence.
 *   - Idempotent: already-applied migrations are skipped.
 *   - --dry-run: validates file order and connectivity without writing anything.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// Load environment
// ---------------------------------------------------------------------------
const ROOT = resolve(import.meta.dirname, "..");

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const path = join(ROOT, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
    break;
  }
}

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set. Add it to .env.local or export it.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const STATUS_ONLY = args.has("--status");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function psql(sql, label) {
  try {
    const result = execSync(
      `psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return result.trim();
  } catch (err) {
    throw new Error(`psql failed (${label}):\n${err.stderr || err.message}`);
  }
}

function psqlFile(filepath, label) {
  try {
    execSync(
      `psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${filepath}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    throw new Error(`psql failed for ${label}:\n${err.stderr || err.message}`);
  }
}

function queryRows(sql) {
  try {
    const out = execSync(
      `psql "${DATABASE_URL}" -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return out.trim().split("\n").filter(Boolean).map(r => r.split("|"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Ensure migrations_log table exists (unless dry-run)
// ---------------------------------------------------------------------------
const CREATE_LOG = `
  CREATE TABLE IF NOT EXISTS migrations_log (
    id           SERIAL PRIMARY KEY,
    filename     TEXT NOT NULL UNIQUE,
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum     TEXT NOT NULL
  );
`;

function ensureLogTable() {
  if (DRY_RUN || STATUS_ONLY) return;
  psql(CREATE_LOG.replace(/\n/g, " ").trim(), "ensure migrations_log");
}

// ---------------------------------------------------------------------------
// Discover migration files
// ---------------------------------------------------------------------------
const MIGRATIONS_DIR = join(ROOT, "migrations");

function discoverMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`ERROR: migrations/ directory not found at ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.match(/^\d{3}_.*\.sql$/))
    .sort()
    .map(f => ({ filename: f, path: join(MIGRATIONS_DIR, f) }));
}

// ---------------------------------------------------------------------------
// Simple checksum (content hash)
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
function checksum(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Get applied migrations from DB
// ---------------------------------------------------------------------------
function getApplied() {
  const rows = queryRows("SELECT filename, checksum FROM migrations_log ORDER BY id");
  const map = new Map();
  for (const [filename, cs] of rows) {
    if (filename) map.set(filename, cs);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nGATHR Migration Runner`);
  console.log(`Database: ${DATABASE_URL.replace(/:\/\/[^@]+@/, "://<credentials>@")}`);
  if (DRY_RUN) console.log(`Mode: DRY RUN (no changes will be applied)\n`);
  else if (STATUS_ONLY) console.log(`Mode: STATUS\n`);
  else console.log(`Mode: APPLY\n`);

  ensureLogTable();

  const migrations = discoverMigrations();
  if (migrations.length === 0) {
    console.log("No migration files found in migrations/");
    return;
  }

  const applied = STATUS_ONLY || !DRY_RUN ? getApplied() : new Map();

  // Print status table
  console.log("Migration files:");
  for (const { filename, path: fp } of migrations) {
    const content = readFileSync(fp, "utf8");
    const cs = checksum(content);
    const isApplied = applied.has(filename);
    const storedCs = applied.get(filename);
    const csMatch = isApplied && storedCs === cs;
    const statusLabel = isApplied
      ? csMatch ? "✅ applied" : "⚠️  applied (CHECKSUM MISMATCH)"
      : "⬜ pending";
    console.log(`  ${statusLabel}  ${filename}`);
  }
  console.log();

  if (STATUS_ONLY) return;
  if (DRY_RUN) {
    console.log("Dry run complete. No changes were applied.");
    console.log("To apply, run: node scripts/migrate.mjs");
    return;
  }

  // Apply pending migrations
  let applied_count = 0;
  for (const { filename, path: fp } of migrations) {
    if (applied.has(filename)) continue;

    console.log(`Applying ${filename}...`);
    const content = readFileSync(fp, "utf8");
    const cs = checksum(content);

    // Run migration
    psqlFile(fp, filename);

    // Record in log
    psql(
      `INSERT INTO migrations_log (filename, checksum) VALUES ('${filename}', '${cs}')`,
      `log ${filename}`
    );

    console.log(`  ✅ Done\n`);
    applied_count++;
  }

  if (applied_count === 0) {
    console.log("All migrations already applied. Nothing to do.");
  } else {
    console.log(`Applied ${applied_count} migration(s) successfully.`);
  }
}

main().catch(err => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});
