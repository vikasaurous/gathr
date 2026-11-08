import * as fs from "node:fs";
import { Pool } from "@neondatabase/serverless";

const envContent = fs.readFileSync(".env.local", "utf8");
let db = "";
for (const line of envContent.split(/\r?\n/)) {
  if (line.startsWith("DATABASE_URL=")) {
    db = line.slice(13).replace(/^["']|["']$/g, "");
  }
}

const pool = new Pool({ connectionString: db });
const res = await pool.query('SELECT * FROM "verification" ORDER BY "createdAt" DESC LIMIT 5');
console.log("Recent verification rows:", res.rows);
await pool.end();

