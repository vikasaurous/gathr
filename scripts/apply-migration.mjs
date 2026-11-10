/**
 * Applies auth-migration.sql against the DATABASE_URL in .env.local.
 * Run once: node scripts/apply-migration.mjs
 *
 * Sends all DDL in a single query call so FK references resolve in order.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Manually load .env.local
const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const envLocal = readFileSync(join(root, ".env.local"), "utf8");
for (const line of envLocal.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const { Pool } = await import("@neondatabase/serverless");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("ERROR: DATABASE_URL is not set in .env.local");
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const client = await pool.connect();

const migration = readFileSync(join(root, "auth-migration.sql"), "utf8");

console.log("Applying Better Auth migration to development branch…\n");

try {
  await client.query("BEGIN");
  await client.query(migration);
  await client.query("COMMIT");
  console.log("✅ Migration complete — all tables and indexes created.");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
