#!/usr/bin/env node
/**
 * GATHR migration runner.
 *
 *   npm run migrate:status          list applied / pending migrations (read-only)
 *   npm run migrate:dry-run         show what would be applied (read-only)
 *   npm run migrate:verify          compare the live schema with the expected shape (read-only)
 *   npm run migrate -- --yes        apply pending migrations (writes!)
 *
 * Safety:
 *   - Applying requires --yes, and the target database host is always printed first.
 *   - Each migration runs in ONE transaction together with its ledger row, so a
 *     failure leaves the database exactly as it was (no half-applied files).
 *   - A pg_advisory_xact_lock serializes concurrent runs.
 *   - Editing an already-applied migration, a missing file, a misnamed file or a
 *     numbering gap stops the run (exit 1) instead of being skipped.
 *   - Checksums ignore line endings, so Windows and Linux agree.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { LEDGER_TABLE_SQL, MIGRATION_LOCK_KEY, runMigrations } from "./lib/migrate-core.mjs";
import { verifySchema } from "./lib/schema-expectations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");

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
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
    break;
  }
}

function describeTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

loadEnv();
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set. Add it to .env.local or export it.");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const sql = neon(DATABASE_URL);

const db = {
  async ensureLog() {
    await sql.query(LEDGER_TABLE_SQL);
  },
  async getApplied() {
    try {
      const rows = await sql.query("SELECT filename, checksum FROM migrations_log ORDER BY id");
      return new Map(rows.map((row) => [row.filename, row.checksum]));
    } catch (error) {
      // Only "table does not exist" means "nothing applied yet"; any other error
      // (network, permissions) must stop the run, never be read as an empty ledger.
      if (error && error.code === "42P01") return new Map();
      throw error;
    }
  },
  async applyMigration({ filename, checksum, statements }) {
    await sql.transaction([
      sql.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]),
      ...statements.map((statement) => sql.query(statement)),
      sql.query("INSERT INTO migrations_log (filename, checksum) VALUES ($1, $2)", [
        filename,
        checksum,
      ]),
    ]);
  },
};

function printPlan(result) {
  console.log("Migration files:");
  for (const file of result.applied) console.log(`  applied   ${file.filename}`);
  for (const file of result.pending)
    console.log(`  pending   ${file.filename}  (${file.statements.length} statements)`);
  console.log();
}

async function main() {
  console.log("\nGATHR migrations");
  console.log(`Database: ${describeTarget(DATABASE_URL)}\n`);

  if (args.has("--verify")) {
    const { ok, problems } = await verifySchema((text) => sql.query(text));
    if (ok) {
      console.log("Schema matches the expected shape. Nothing was changed.");
      return 0;
    }
    console.error("Schema differs from the expected shape:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  const wantsApply = !args.has("--status") && !args.has("--dry-run");
  const mode =
    wantsApply && args.has("--yes") ? "apply" : args.has("--dry-run") ? "dry-run" : "status";

  const result = await runMigrations({ db, dir: MIGRATIONS_DIR, mode, log: console.log });
  if (!result.ok) {
    console.error("Migration check failed:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }
  printPlan(result);

  if (wantsApply && mode !== "apply") {
    console.log(
      "Nothing was applied. Re-run with --yes to apply the pending migrations to the database above:",
    );
    console.log("  npm run migrate -- --yes");
    return result.pending.length > 0 ? 2 : 0;
  }
  if (mode === "apply") {
    console.log(
      result.appliedNow.length === 0
        ? "All migrations already applied. Nothing to do."
        : `Applied ${result.appliedNow.length} migration(s).`,
    );
  } else if (mode === "dry-run") {
    console.log("Dry run complete. No changes were applied.");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("\nMigration failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
