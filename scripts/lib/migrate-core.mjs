/**
 * Migration core — pure logic shared by scripts/migrate.mjs and the test suite.
 * No database driver is imported here: callers inject a `db` adapter, so the
 * same code runs against Neon (CLI) and an in-process Postgres (tests).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS migrations_log (
  id           SERIAL PRIMARY KEY,
  filename     TEXT NOT NULL UNIQUE,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum     TEXT NOT NULL
)`;

/** Arbitrary constant: serializes concurrent migration runs via pg_advisory_xact_lock. */
export const MIGRATION_LOCK_KEY = 727274;

const MIGRATION_NAME_RE = /^\d{3}_[a-z0-9_]+\.sql$/;

export function normalizeSql(content) {
  return content.replace(/\r\n?/g, "\n");
}

/** Line-ending independent, so Windows and Linux checkouts agree. */
export function checksum(content) {
  return createHash("sha256").update(normalizeSql(content)).digest("hex").slice(0, 16);
}

/**
 * Splits a SQL script into statements without being fooled by semicolons or
 * "--" inside string literals, quoted identifiers, dollar-quoted blocks
 * (DO $$ ... $$) or comments. Comments are dropped.
 */
export function splitStatements(content) {
  const text = normalizeSql(content);
  const statements = [];
  let current = "";
  let i = 0;
  const n = text.length;
  const flush = () => {
    const stmt = current.trim();
    if (stmt) statements.push(stmt);
    current = "";
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "-" && next === "-") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) throw new Error("Unterminated block comment in SQL.");
      current += " ";
      continue;
    }

    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n)
          throw new Error(
            `Unterminated ${ch === "'" ? "string literal" : "quoted identifier"} in SQL.`,
          );
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === "$" && !/[A-Za-z0-9_$]/.test(text[i - 1] ?? "")) {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`Unterminated dollar-quoted block ${tag} in SQL.`);
        current += text.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }

    if (ch === ";") {
      flush();
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  flush();
  return statements;
}

/**
 * Reads and validates the migrations directory. Fails closed: a misnamed
 * file, a duplicate number or a gap in numbering is an error, never silently
 * skipped (a skipped file means a schema change that never runs).
 */
export function discoverMigrations(dir) {
  if (!existsSync(dir)) throw new Error(`Migrations directory not found: ${dir}`);
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const invalid = names.filter((f) => !MIGRATION_NAME_RE.test(f));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid migration file name(s): ${invalid.join(", ")}. Use NNN_description.sql (lowercase letters, digits, underscores).`,
    );
  }

  const seen = new Set();
  names.forEach((name, index) => {
    const number = Number(name.slice(0, 3));
    if (seen.has(number))
      throw new Error(`Duplicate migration number ${name.slice(0, 3)}: ${name}`);
    seen.add(number);
    const expected = String(index + 1).padStart(3, "0");
    if (name.slice(0, 3) !== expected) {
      throw new Error(
        `Migration numbering must be contiguous from 001: expected ${expected}, found ${name}`,
      );
    }
  });

  return names.map((filename) => {
    const content = readFileSync(join(dir, filename), "utf8");
    return {
      filename,
      number: Number(filename.slice(0, 3)),
      checksum: checksum(content),
      statements: splitStatements(content),
    };
  });
}

/**
 * Compares migration files with the ledger. Any problem blocks applying:
 * edited applied files, files missing for ledger rows, and out-of-order gaps.
 */
export function planMigrations(files, applied) {
  const problems = [];
  const fileNames = new Set(files.map((f) => f.filename));
  for (const name of applied.keys()) {
    if (!fileNames.has(name)) {
      problems.push(`Applied migration ${name} has no matching file in migrations/.`);
    }
  }

  const pending = [];
  const alreadyApplied = [];
  let sawPending = false;
  for (const file of files) {
    const stored = applied.get(file.filename);
    if (stored === undefined) {
      pending.push(file);
      sawPending = true;
      continue;
    }
    alreadyApplied.push(file);
    if (stored !== file.checksum) {
      problems.push(
        `Checksum mismatch for applied migration ${file.filename} (ledger ${stored}, file ${file.checksum}). Applied migrations must never be edited; add a new migration instead.`,
      );
    }
    if (sawPending) {
      problems.push(
        `Migration ${file.filename} is applied but an earlier migration is still pending (out of order).`,
      );
    }
  }
  return { pending, applied: alreadyApplied, problems };
}

/**
 * mode: "status" and "dry-run" are read-only; only "apply" writes.
 * db: { ensureLog(), getApplied(), applyMigration({ filename, checksum, statements }) }
 * applyMigration must be atomic: all statements and the ledger row, or nothing.
 */
export async function runMigrations({ db, dir, mode = "status", log = () => {} }) {
  const files = discoverMigrations(dir);
  if (mode === "apply") await db.ensureLog();
  const applied = await db.getApplied();
  const plan = planMigrations(files, applied);
  if (plan.problems.length > 0) return { ...plan, appliedNow: [], ok: false };
  if (mode !== "apply") return { ...plan, appliedNow: [], ok: true };

  const appliedNow = [];
  for (const file of plan.pending) {
    log(`Applying ${file.filename} (${file.statements.length} statements)...`);
    try {
      await db.applyMigration({
        filename: file.filename,
        checksum: file.checksum,
        statements: file.statements,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${file.filename} failed and was rolled back: ${reason}`, {
        cause: error,
      });
    }
    appliedNow.push(file.filename);
  }
  return { ...plan, appliedNow, ok: true };
}
