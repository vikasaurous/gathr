import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const envLocal = readFileSync(join(root, ".env.local"), "utf8");
for (const line of envLocal.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim(),
    v = t.slice(eq + 1).trim();
  if (!process.env[k]) process.env[k] = v;
}
const { Pool } = await import("@neondatabase/serverless");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const { rows } = await client.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('user','session','account','verification')
  ORDER BY table_name
`);
console.log("Tables in development database:");
rows.forEach((r) => console.log(" ✓", r.table_name));
client.release();
await pool.end();
