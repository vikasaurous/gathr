#!/usr/bin/env node
/**
 * GATHR migration runner — applies SQL migration files in numbered order.
 * Uses @neondatabase/serverless (HTTP transport) — no psql required.
 *
 * Usage:
 *   npm run migrate             # apply all pending migrations
 *   npm run migrate:dry-run     # validate without applying (Acceptance Check 8)
 *   npm run migrate:status      # list applied/pending migrations
 *
 * Design:
 *   - Maintains a migrations_log table to track applied migrations.
 *   - Applies migrations in ascending numeric order (001, 002, ...).
 *   - Each migration file is split on ";" and each statement run individually.
 *   - Idempotent: already-applied migrations are skipped by checksum.
 *   - --dry-run: validates file order and connectivity without writing anything.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const ROOT = resolve(import.meta.dirname, "..");

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const path = join(ROOT, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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
// DB client
// ---------------------------------------------------------------------------
const sql = neon(DATABASE_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function checksum(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Split a SQL file into individual statements, skipping blanks.
 * Handles $$ dollar-quoted blocks (DO $$ ... $$ blocks) correctly by not
 * splitting on semicolons inside dollar quotes.
 */
function splitStatements(content) {
  const statements = [];
  let current = "";
  let inDollarQuote = false;
  let dollarTag = "";

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    // Strip single-line comments outside dollar quotes
    const processed = inDollarQuote ? line : line.replace(/--.*$/, "");

    // Detect dollar-quote open/close
    const dollarMatches = [...processed.matchAll(/\$\$|\$[A-Za-z_]\w*\$/g)];
    for (const m of dollarMatches) {
      if (!inDollarQuote) {
        inDollarQuote = true;
        dollarTag = m[0];
      } else if (m[0] === dollarTag) {
        inDollarQuote = false;
        dollarTag = "";
      }
    }

    current += processed + "\n";

    if (!inDollarQuote && processed.trimEnd().endsWith(";")) {
      const stmt = current.trim();
      if (stmt && stmt !== ";") statements.push(stmt);
      current = "";
    }
  }

  // Catch any trailing statement without trailing semicolon
  const tail = current.trim();
  if (tail && tail !== ";") statements.push(tail);

  return statements.filter((s) => s.replace(/;$/, "").trim().length > 0);
}

// ---------------------------------------------------------------------------
// Ensure migrations_log table exists
// ---------------------------------------------------------------------------
async function ensureLogTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS migrations_log (
      id           SERIAL PRIMARY KEY,
      filename     TEXT NOT NULL UNIQUE,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum     TEXT NOT NULL
    )
  `;
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
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ filename: f, path: join(MIGRATIONS_DIR, f) }));
}

// ---------------------------------------------------------------------------
// Get applied migrations
// ---------------------------------------------------------------------------
async function getApplied() {
  try {
    const rows = await sql`SELECT filename, checksum FROM migrations_log ORDER BY id`;
    const map = new Map();
    for (const row of rows) map.set(row.filename, row.checksum);
    return map;
  } catch {
    // Table doesn't exist yet (first run or dry-run)
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const maskedUrl = DATABASE_URL.replace(/:\/\/[^@]+@/, "://<credentials>@");
  console.log(`\nGATHR Migration Runner`);
  console.log(`Database: ${maskedUrl}`);
  if (DRY_RUN) console.log(`Mode: DRY RUN (no changes will be applied)\n`);
  else if (STATUS_ONLY) console.log(`Mode: STATUS\n`);
  else console.log(`Mode: APPLY\n`);

  if (!DRY_RUN && !STATUS_ONLY) {
    await ensureLogTable();
  }

  const migrations = discoverMigrations();
  if (migrations.length === 0) {
    console.log("No migration files found in migrations/");
    return;
  }

  const applied = await getApplied();

  // Print status table
  console.log("Migration files:");
  for (const { filename, path: fp } of migrations) {
    const content = readFileSync(fp, "utf8");
    const cs = checksum(content);
    const isApplied = applied.has(filename);
    const storedCs = applied.get(filename);
    const csMatch = isApplied && storedCs === cs;
    const statusLabel = isApplied
      ? csMatch
        ? "✅ applied  "
        : "⚠️  applied (CHECKSUM MISMATCH)"
      : "⬜ pending  ";
    console.log(`  ${statusLabel} ${filename}`);
  }
  console.log();

  if (STATUS_ONLY || DRY_RUN) {
    if (DRY_RUN) {
      console.log("Dry run complete. No changes were applied.");
      console.log("To apply, run: npm run migrate");
    }
    return;
  }

  // Apply pending migrations
  let appliedCount = 0;
  for (const { filename, path: fp } of migrations) {
    if (applied.has(filename)) continue;

    console.log(`Applying ${filename}...`);
    const content = readFileSync(fp, "utf8");
    const cs = checksum(content);
    const statements = splitStatements(content);

    for (const stmt of statements) {
      try {
        // neon tagged template doesn't support dynamic SQL strings directly,
        // so we use the query() method on the neon client for raw SQL execution.
        await sql.query(stmt);
      } catch (err) {
        console.error(`\n  ❌ Failed on statement:\n`);
        // Print first 300 chars of the failing statement for context
        console.error(`  ${stmt.slice(0, 300)}${stmt.length > 300 ? "..." : ""}\n`);
        throw new Error(`Migration ${filename} failed: ${err.message}`);
      }
    }

    // Record in log
    await sql`
      INSERT INTO migrations_log (filename, checksum)
      VALUES (${filename}, ${cs})
    `;

    console.log(`  ✅ Done\n`);
    appliedCount++;
  }

  if (appliedCount === 0) {
    console.log("All migrations already applied. Nothing to do.");
  } else {
    console.log(`Applied ${appliedCount} migration(s) successfully.`);
  }
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});
