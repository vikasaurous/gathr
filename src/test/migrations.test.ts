// @vitest-environment node
/**
 * Phase 2 — data model and migrations.
 *
 * Runs the REAL migration files against an in-process Postgres (PGlite), so the
 * acceptance checks run on every `npm test` without touching any live database.
 * Query-plan checks assert that a suitable index EXISTS and is usable for each
 * main query (sequential scans are disabled to remove cost-model noise at test
 * volume); they are not a substitute for reviewing plans on production data.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LEDGER_TABLE_SQL,
  checksum,
  discoverMigrations,
  planMigrations,
  runMigrations,
  splitStatements,
  type MigrationDb,
} from "../../scripts/lib/migrate-core.mjs";
import { verifySchema } from "../../scripts/lib/schema-expectations.mjs";

/** Loosely typed catalog/query row; the named fields are the ones these tests read. */
type Row = {
  id: string;
  filename: string;
  table_name: string;
  data_type: string;
  c: number;
  status: string;
} & Record<string, unknown>;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

function pgliteAdapter(pg: PGlite): MigrationDb {
  return {
    async ensureLog() {
      await pg.exec(LEDGER_TABLE_SQL);
    },
    async getApplied() {
      try {
        const { rows } = await pg.query<{ filename: string; checksum: string }>(
          "SELECT filename, checksum FROM migrations_log ORDER BY id",
        );
        return new Map(rows.map((r) => [r.filename, r.checksum]));
      } catch (error) {
        if ((error as { code?: string }).code === "42P01") return new Map();
        throw error;
      }
    },
    async applyMigration({ filename, checksum: sum, statements }) {
      await pg.transaction(async (tx) => {
        for (const statement of statements) await tx.query(statement);
        await tx.query("INSERT INTO migrations_log (filename, checksum) VALUES ($1, $2)", [
          filename,
          sum,
        ]);
      });
    },
  };
}

const rowsOf = async (pg: PGlite, text: string, params: unknown[] = []) =>
  (await pg.query<Row>(text, params)).rows;

async function fails(pg: PGlite, text: string, params: unknown[], code: string) {
  try {
    await pg.query(text, params);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Statement was accepted but should fail with ${code}: ${text}`);
}

describe("splitStatements", () => {
  it("splits on semicolons and drops comments", () => {
    expect(splitStatements("-- a\nSELECT 1; /* x; y */ SELECT 2;\n")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });
  it("is not fooled by semicolons or -- inside string literals and identifiers", () => {
    const sql = `INSERT INTO t VALUES ('a;b -- c'); SELECT "we;ird" FROM t;`;
    expect(splitStatements(sql)).toEqual([
      `INSERT INTO t VALUES ('a;b -- c')`,
      `SELECT "we;ird" FROM t`,
    ]);
  });
  it("keeps dollar-quoted blocks whole", () => {
    const sql = "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$; SELECT $1;";
    expect(splitStatements(sql)).toEqual(["DO $$ BEGIN PERFORM 1; PERFORM 2; END $$", "SELECT $1"]);
  });
  it("rejects unterminated quotes instead of guessing", () => {
    expect(() => splitStatements("SELECT 'oops;")).toThrow(/Unterminated/);
    expect(() => splitStatements("DO $$ BEGIN")).toThrow(/Unterminated/);
  });
  it("treats CRLF and LF identically", () => {
    expect(splitStatements("SELECT 1;\r\nSELECT 2;\r\n")).toEqual(
      splitStatements("SELECT 1;\nSELECT 2;\n"),
    );
    expect(checksum("a\r\nb\r\n")).toBe(checksum("a\nb\n"));
  });
});

describe("discoverMigrations / planMigrations", () => {
  const dirs: string[] = [];
  const tempDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "gathr-mig-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("fails closed on misnamed files (they would otherwise be silently skipped)", () => {
    expect(() =>
      discoverMigrations(tempDir({ "001_a.sql": "SELECT 1;", "002-user-plan.sql": "SELECT 1;" })),
    ).toThrow(/Invalid migration file name/);
  });
  it("rejects duplicate numbers and gaps", () => {
    expect(() =>
      discoverMigrations(tempDir({ "001_a.sql": "SELECT 1;", "001_b.sql": "SELECT 1;" })),
    ).toThrow(/Duplicate migration number/);
    expect(() =>
      discoverMigrations(tempDir({ "001_a.sql": "SELECT 1;", "003_c.sql": "SELECT 1;" })),
    ).toThrow(/contiguous/);
  });
  it("the committed migrations directory is valid and contiguous", () => {
    const files = discoverMigrations(MIGRATIONS_DIR);
    expect(files.map((f) => f.number)).toEqual(files.map((_, i) => i + 1));
    expect(files.length).toBeGreaterThanOrEqual(5);
  });
  it("applied migrations are immutable (checksums match the development ledger)", () => {
    const sums = Object.fromEntries(
      discoverMigrations(MIGRATIONS_DIR).map((f) => [f.filename, f.checksum]),
    );
    expect(sums["001_auth_schema.sql"]).toBe("3d7d1383828cedb6");
    expect(sums["002_gathr_ingestion_schema.sql"]).toBe("d5017395fd07156a");
    expect(sums["003_add_review_status.sql"]).toBe("2245c69aa915be22");
  });
  it("flags edited, missing and out-of-order migrations", () => {
    const files = discoverMigrations(
      tempDir({ "001_a.sql": "SELECT 1;", "002_b.sql": "SELECT 2;", "003_c.sql": "SELECT 3;" }),
    );
    const [a, b, c] = files;
    expect(planMigrations(files, new Map()).problems).toEqual([]);
    expect(planMigrations(files, new Map([[a!.filename, "deadbeef"]])).problems[0]).toMatch(
      /Checksum mismatch/,
    );
    expect(planMigrations(files, new Map([["000_gone.sql", "x"]])).problems[0]).toMatch(
      /no matching file/,
    );
    const outOfOrder = planMigrations(
      files,
      new Map([
        [c!.filename, c!.checksum],
        [a!.filename, a!.checksum],
      ]),
    );
    expect(outOfOrder.problems.join()).toMatch(/out of order/);
    expect(b).toBeDefined();
  });
});

describe("runMigrations (atomic, ledger-tracked)", () => {
  it("applies everything in order on an empty database, then is a no-op", async () => {
    const pg = new PGlite();
    const db = pgliteAdapter(pg);
    const first = await runMigrations({ db, dir: MIGRATIONS_DIR, mode: "apply" });
    expect(first.ok).toBe(true);
    expect(first.appliedNow.length).toBe(first.applied.length + first.pending.length);
    const second = await runMigrations({ db, dir: MIGRATIONS_DIR, mode: "apply" });
    expect(second.appliedNow).toEqual([]);
    const ledger = await rowsOf(pg, "SELECT filename FROM migrations_log ORDER BY id");
    expect(ledger.map((r) => r.filename)).toEqual(first.appliedNow);
    await pg.close();
  }, 60_000);

  it("status and dry-run never write anything, not even the ledger table", async () => {
    const pg = new PGlite();
    const db = pgliteAdapter(pg);
    for (const mode of ["status", "dry-run"] as const) {
      const result = await runMigrations({ db, dir: MIGRATIONS_DIR, mode });
      expect(result.ok).toBe(true);
      expect(result.appliedNow).toEqual([]);
      expect(result.pending.length).toBeGreaterThan(0);
    }
    const tables = await rowsOf(
      pg,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables).toEqual([]);
    await pg.close();
  }, 60_000);

  it("rolls a failing migration back completely, including its ledger row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gathr-mig-"));
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a (id int);");
    writeFileSync(
      join(dir, "002_bad.sql"),
      "CREATE TABLE b (id int);\nINSERT INTO does_not_exist VALUES (1);",
    );
    const pg = new PGlite();
    await expect(runMigrations({ db: pgliteAdapter(pg), dir, mode: "apply" })).rejects.toThrow(
      /rolled back/,
    );
    const tables = (
      await rowsOf(
        pg,
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      )
    ).map((r) => r.table_name);
    expect(tables).toContain("a");
    expect(tables).not.toContain("b");
    const ledger = await rowsOf(pg, "SELECT filename FROM migrations_log");
    expect(ledger.map((r) => r.filename)).toEqual(["001_ok.sql"]);
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("refuses to apply anything when an applied migration was edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gathr-mig-"));
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id int);");
    const pg = new PGlite();
    const db = pgliteAdapter(pg);
    await runMigrations({ db, dir, mode: "apply" });
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id int, extra int);");
    writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (id int);");
    const result = await runMigrations({ db, dir, mode: "apply" });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/Checksum mismatch/);
    expect(result.appliedNow).toEqual([]);
    const tables = (
      await rowsOf(
        pg,
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      )
    ).map((r) => r.table_name);
    expect(tables).not.toContain("b");
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe("Phase 2 acceptance checks against the migrated schema", () => {
  let pg: PGlite;
  let wsA: string;
  let wsB: string;
  let batchA: string;
  let batchB: string;

  beforeAll(async () => {
    pg = new PGlite();
    const result = await runMigrations({
      db: pgliteAdapter(pg),
      dir: MIGRATIONS_DIR,
      mode: "apply",
    });
    expect(result.ok).toBe(true);
    await pg.exec(
      `insert into "user"(id,name,email) values ('uA','A','a@x.com'),('uB','B','b@x.com')`,
    );
    wsA = (
      await rowsOf(pg, `insert into workspaces(owner_user_id,name) values ('uA','WA') returning id`)
    )[0]!.id;
    wsB = (
      await rowsOf(pg, `insert into workspaces(owner_user_id,name) values ('uB','WB') returning id`)
    )[0]!.id;
    batchA = (
      await rowsOf(pg, `insert into batches(workspace_id,name) values ($1,'bA') returning id`, [
        wsA,
      ])
    )[0]!.id;
    batchB = (
      await rowsOf(pg, `insert into batches(workspace_id,name) values ($1,'bB') returning id`, [
        wsB,
      ])
    )[0]!.id;
  }, 90_000);
  afterAll(async () => {
    await pg.close();
  });

  const insertDoc = (ws: string, batch: string, extra = "", extraValues = "", filename = "a.pdf") =>
    pg.query(
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes${extra}) values ($1,$2,$3,1000${extraValues})`,
      [ws, batch, filename],
    );

  it("1/3. creates every table and the user id types match Better Auth (TEXT)", async () => {
    const types = await rowsOf(
      pg,
      `select table_name, column_name, data_type from information_schema.columns where table_schema='public'
         and ((table_name='user' and column_name='id') or (table_name='session' and column_name='userId')
           or (table_name='account' and column_name='userId') or (table_name='workspaces' and column_name='owner_user_id')
           or (table_name='user_plan' and column_name='userId'))`,
    );
    expect(types).toHaveLength(5);
    expect(types.every((t) => t.data_type === "text")).toBe(true);
  });

  it("2. a schema created before review_status existed is brought up to shape by migration 003", async () => {
    const files = discoverMigrations(MIGRATIONS_DIR);
    const old = new PGlite();
    await old.exec(files[0]!.statements.join(";\n") + ";");
    const m2 = files[1]!.statements
      .join(";\n")
      .replace(/\s*"review_status"\s+TEXT NULL,/, "")
      .replace(/,\s*CONSTRAINT "ck_documents_review_status"\s*CHECK \([^;]*?'skipped'\)\)/s, "")
      .replace(
        /,\s*CONSTRAINT "ck_documents_review_requires_upload"\s*CHECK \(\s*"review_status" IS NULL OR "status" = 'uploaded'\)/s,
        "",
      )
      .replace(/CREATE INDEX IF NOT EXISTS "documents_review_queue_idx"[^;]*/s, "SELECT 1");
    expect(m2).not.toMatch(/review_status/);
    await old.exec(m2 + ";");
    await old.exec(`insert into "user"(id,name,email) values ('u1','A','a@x.com')`);
    await old.exec(`insert into workspaces(owner_user_id,name) select 'u1','W'`);
    await old.exec(`insert into batches(workspace_id,name) select id,'b' from workspaces`);
    await old.exec(
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,status) select workspace_id,id,'a.pdf',100,'uploaded' from batches`,
    );
    for (const f of files.slice(2)) {
      for (const s of f.statements) await old.query(s);
    }
    expect(await rowsOf(old, "select count(*)::int c from documents")).toEqual([{ c: 1 }]);
    const result = await verifySchema((text) => old.query<Row>(text).then((r) => r.rows));
    expect(result.problems).toEqual([]);
    await old.close();
  }, 60_000);

  it("4. the database rejects a document attached to another workspace's batch", async () => {
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes) values ($1,$2,'a.pdf',10)`,
      [wsA, batchB],
      "23503",
    );
    await expect(insertDoc(wsA, batchA)).resolves.toBeDefined();
    await fails(
      pg,
      `insert into workspaces(owner_user_id,name) values ('uA','second')`,
      [],
      "23505",
    );
  });

  it("5. rejects invalid statuses", async () => {
    await fails(
      pg,
      `insert into batches(workspace_id,name,status) values ($1,'x','open')`,
      [wsA],
      "23514",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,status) values ($1,$2,'a.pdf',10,'pending')`,
      [wsA, batchA],
      "23514",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,status,review_status) values ($1,$2,'a.pdf',10,'uploaded','approved')`,
      [wsA, batchA],
      "23514",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,status,review_status) values ($1,$2,'a.pdf',10,'uploading','needs_review')`,
      [wsA, batchA],
      "23514",
    );
  });

  it("5. rejects zero, negative and oversized file sizes but accepts exactly 50 MiB", async () => {
    for (const size of [0, -5, 52428801]) {
      await fails(
        pg,
        `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes) values ($1,$2,'a.pdf',${size})`,
        [wsA, batchA],
        "23514",
      );
    }
    await expect(
      pg.query(
        `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes) values ($1,$2,'big.pdf',52428800)`,
        [wsA, batchA],
      ),
    ).resolves.toBeDefined();
  });

  it("5. rejects non-PDF types, bad storage keys, bad page counts and missing ownership fields", async () => {
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,mime_type) values ($1,$2,'a.pdf',10,'text/html')`,
      [wsA, batchA],
      "23514",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,storage_key) values ($1,$2,'a.pdf',10,'../etc/passwd')`,
      [wsA, batchA],
      "23514",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,page_count) values ($1,$2,'a.pdf',10,0)`,
      [wsA, batchA],
      "23514",
    );
    await fails(
      pg,
      `insert into documents(batch_id,original_filename,file_size_bytes) values ($1,'a.pdf',10)`,
      [batchA],
      "23502",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,original_filename,file_size_bytes) values ($1,'a.pdf',10)`,
      [wsA],
      "23502",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,file_size_bytes) values ($1,$2,10)`,
      [wsA, batchA],
      "23502",
    );
  });

  it("5. (migration 005) rejects blank and over-long filenames and bad outbox counters", async () => {
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes) values ($1,$2,'',10)`,
      [wsA, batchA],
      "23514",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes) values ($1,$2,'   ',10)`,
      [wsA, batchA],
      "23514",
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes) values ($1,$2,$3,10)`,
      [wsA, batchA, "x".repeat(256)],
      "23514",
    );
    await expect(insertDoc(wsA, batchA, "", "", "x".repeat(255))).resolves.toBeDefined();
    await fails(
      pg,
      `insert into storage_cleanup_outbox(storage_key,bucket_name,reason,attempt_count) values ('gathr/c1','b','upload_failed',-1)`,
      [],
      "23514",
    );
    await fails(
      pg,
      `insert into storage_cleanup_outbox(storage_key,bucket_name,reason,max_attempts) values ('gathr/c2','b','upload_failed',0)`,
      [],
      "23514",
    );
  });

  it("5. enforces a unique canonical storage key", async () => {
    await pg.query(
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,storage_key) values ($1,$2,'k.pdf',10,'gathr/unique-1')`,
      [wsA, batchA],
    );
    await fails(
      pg,
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,storage_key) values ($1,$2,'k2.pdf',10,'gathr/unique-1')`,
      [wsA, batchA],
      "23505",
    );
  });

  it("6. cleanup obligations survive deletion of their batch and documents", async () => {
    await pg.query(
      `insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,storage_key,status) values ($1,$2,'o.pdf',10,'gathr/o1','uploading')`,
      [wsB, batchB],
    );
    const docId = (await rowsOf(pg, `select id from documents where storage_key='gathr/o1'`))[0]!
      .id;
    await pg.query(
      `insert into storage_cleanup_outbox(storage_key,bucket_name,workspace_id,batch_id,document_id,reason) values ('gathr/o1','bkt',$1,$2,$3,'batch_deleted')`,
      [wsB, batchB, docId],
    );
    await pg.query(`delete from batches where id=$1`, [batchB]);
    expect(
      await rowsOf(pg, `select count(*)::int c from documents where batch_id=$1`, [batchB]),
    ).toEqual([{ c: 0 }]);
    expect(
      await rowsOf(pg, `select status from storage_cleanup_outbox where storage_key='gathr/o1'`),
    ).toEqual([{ status: "pending" }]);
    await fails(
      pg,
      `insert into storage_cleanup_outbox(storage_key,bucket_name,reason) values ('gathr/o1','bkt','batch_deleted')`,
      [],
      "23505",
    );
  });

  it("8. verifySchema passes on a fresh schema and detects drift without changing anything", async () => {
    const query = (text: string) => pg.query<Row>(text).then((r) => r.rows);
    expect((await verifySchema(query)).problems).toEqual([]);

    await pg.exec(`alter table documents drop constraint ck_documents_review_status`);
    await pg.exec(`drop index documents_review_queue_idx`);
    await pg.exec(
      `alter table storage_cleanup_outbox add column workspace_ref uuid, add constraint fk_bad foreign key (workspace_ref) references workspaces(id)`,
    );
    const drift = await verifySchema(query);
    expect(drift.ok).toBe(false);
    expect(drift.problems).toEqual(
      expect.arrayContaining([
        "Missing constraint: documents.ck_documents_review_status",
        "Missing index: documents.documents_review_queue_idx",
        "Forbidden foreign key on storage_cleanup_outbox: fk_bad",
      ]),
    );
    // restore so later tests keep a valid schema
    await pg.exec(
      `alter table storage_cleanup_outbox drop constraint fk_bad, drop column workspace_ref`,
    );
    await pg.exec(
      `alter table documents add constraint ck_documents_review_status check (review_status is null or review_status in ('needs_review','verified','duplicate','rejected','skipped'))`,
    );
    await pg.exec(
      `create index documents_review_queue_idx on documents (workspace_id, review_status, uploaded_at) where status='uploaded' and review_status='needs_review'`,
    );
    expect((await verifySchema(query)).problems).toEqual([]);
  });

  describe("7. main queries can use their indexes at volume", () => {
    let ws = "";
    let batch = "";
    let docId = "";
    beforeAll(async () => {
      await pg.exec(`
        insert into "user"(id,name,email) select 'v'||g,'n','v'||g||'@x.com' from generate_series(1,20) g;
        insert into workspaces(owner_user_id,name) select 'v'||g,'w' from generate_series(1,20) g;
        insert into batches(workspace_id,name,status,created_at)
          select w.id,'b'||g,'uploaded', now() - (g||' minutes')::interval from workspaces w, generate_series(1,40) g where w.owner_user_id like 'v%';
        insert into documents(workspace_id,batch_id,original_filename,file_size_bytes,status,review_status,uploaded_at,storage_key,lease_expires_at)
          select b.workspace_id,b.id,'f'||g||'.pdf',1000+g,
                 case when g%10=0 then 'uploading' else 'uploaded' end,
                 case when g%10=0 then null when g%3=0 then 'verified' else 'needs_review' end,
                 now(),'gathr/v/'||b.id||'/'||g, case when g%10=0 then now() - interval '1 hour' end
          from batches b, generate_series(1,20) g where b.name like 'b%' and b.workspace_id in (select id from workspaces where owner_user_id like 'v%');
        insert into storage_cleanup_outbox(storage_key,bucket_name,reason,status,scheduled_at)
          select 'gathr/out/'||g,'b','upload_failed', case when g%50=0 then 'pending' else 'completed' end, now()-(g||' seconds')::interval from generate_series(1,5000) g;
        analyze;`);
      ws = (await rowsOf(pg, `select id from workspaces where owner_user_id = 'v1'`))[0]!.id;
      batch = (await rowsOf(pg, `select id from batches where workspace_id=$1 limit 1`, [ws]))[0]!
        .id;
      docId = (await rowsOf(pg, `select id from documents where workspace_id=$1 limit 1`, [ws]))[0]!
        .id;
      await pg.exec(`set enable_seqscan = off`);
    }, 90_000);

    const plan = async (text: string, params: unknown[] = []) =>
      (await rowsOf(pg, `explain ${text}`, params)).map((r) => r["QUERY PLAN"]).join("\n");

    it.each([
      [
        "workspace batch list, newest first",
        `select id,name from batches where workspace_id=$1 order by created_at desc limit 20`,
        "ws",
        "batches_workspace_created_at_idx",
      ],
      [
        "documents of a batch, oldest first",
        `select id from documents where batch_id=$1 order by created_at`,
        "batch",
        "documents_batch_created_at_idx",
      ],
      [
        "ownership lookup by document id and workspace",
        `select id from documents where id=$1 and workspace_id=$2`,
        "doc",
        "documents_pkey",
      ],
      [
        "review queue for a workspace",
        `select id from documents where workspace_id=$1 and status='uploaded' and review_status='needs_review' order by uploaded_at limit 50`,
        "ws",
        "documents_review_queue_idx",
      ],
      [
        "stale upload reaper",
        `select id from documents where status='uploading' and lease_expires_at < now() limit 100`,
        "none",
        "documents_active_lease_idx",
      ],
      [
        "cleanup dispatch",
        `select id from storage_cleanup_outbox where status in ('pending','processing') and scheduled_at <= now() order by scheduled_at limit 50`,
        "none",
        "idx_storage_cleanup_dispatch",
      ],
    ])("%s uses %s", async (_label, text, kind, index) => {
      const params =
        kind === "ws" ? [ws] : kind === "batch" ? [batch] : kind === "doc" ? [docId, ws] : [];
      const text2 = await plan(text, params);
      expect(text2).toContain(index);
      expect(text2).not.toMatch(/Seq Scan/);
    });
  });
});

describe("Phase 3 migration 006 — batch idempotency", () => {
  it("enforces idempotency_key + request_hash pairing and workspace-scoped uniqueness", async () => {
    const pg = new PGlite();
    const res = await runMigrations({
      db: pgliteAdapter(pg),
      dir: MIGRATIONS_DIR,
      mode: "apply",
    });
    expect(res.ok).toBe(true);
    expect(res.appliedNow).toContain("006_batch_idempotency.sql");

    await pg.exec(
      `insert into "user"(id,name,email) values ('u1','A','a@x.com'),('u2','B','b@x.com')`,
    );
    const ws1 = (
      await rowsOf(pg, `insert into workspaces(owner_user_id,name) values ('u1','W1') returning id`)
    )[0]!.id;
    const ws2 = (
      await rowsOf(pg, `insert into workspaces(owner_user_id,name) values ('u2','W2') returning id`)
    )[0]!.id;

    // Pairing check constraint rejects incomplete idempotency metadata or >128 char keys
    await fails(
      pg,
      `insert into batches(workspace_id,name,idempotency_key) values ($1,'b','k1')`,
      [ws1],
      "23514",
    );
    await fails(
      pg,
      `insert into batches(workspace_id,name,request_hash) values ($1,'b','h1')`,
      [ws1],
      "23514",
    );
    await fails(
      pg,
      `insert into batches(workspace_id,name,idempotency_key,request_hash) values ($1,'b',$2,'h1')`,
      [ws1, "k".repeat(129)],
      "23514",
    );

    // Multiple NULL idempotency keys allowed in the same workspace
    await expect(
      pg.query(`insert into batches(workspace_id,name) values ($1,'b1'),($1,'b2')`, [ws1]),
    ).resolves.toBeDefined();

    // Same idempotency_key rejected within the same workspace, allowed across different workspaces
    await pg.query(
      `insert into batches(workspace_id,name,idempotency_key,request_hash) values ($1,'b3','same-key','hash-a')`,
      [ws1],
    );
    await fails(
      pg,
      `insert into batches(workspace_id,name,idempotency_key,request_hash) values ($1,'b4','same-key','hash-a')`,
      [ws1],
      "23505",
    );
    await expect(
      pg.query(
        `insert into batches(workspace_id,name,idempotency_key,request_hash) values ($1,'b5','same-key','hash-b')`,
        [ws2],
      ),
    ).resolves.toBeDefined();

    await pg.close();
  }, 60_000);
});

describe("Phase 5 migration 007 — batch finalization & cleanup lease index", () => {
  it("enforces ck_batches_finalized_status and creates idx_storage_cleanup_processing_lease", async () => {
    const pg = new PGlite();
    const res = await runMigrations({
      db: pgliteAdapter(pg),
      dir: MIGRATIONS_DIR,
      mode: "apply",
    });
    expect(res.ok).toBe(true);
    expect(res.appliedNow).toContain("007_batch_lifecycle.sql");

    await pg.exec(`insert into "user"(id,name,email) values ('u5','P5','p5@x.com')`);
    const ws = (
      await rowsOf(pg, `insert into workspaces(owner_user_id,name) values ('u5','W5') returning id`)
    )[0]!.id;

    // Sealed batches cannot remain in 'uploading' status
    await fails(
      pg,
      `insert into batches(workspace_id,name,status,finalized_at) values ($1,'b-bad','uploading',now())`,
      [ws],
      "23514",
    );

    // Sealed batches allow 'uploaded', 'partial', and 'failed'
    await expect(
      pg.query(
        `insert into batches(workspace_id,name,status,finalized_at) values
         ($1,'b-ok','uploaded',now()),
         ($1,'b-part','partial',now()),
         ($1,'b-fail','failed',now())`,
        [ws],
      ),
    ).resolves.toBeDefined();

    const idx = await rowsOf(
      pg,
      `select indexname from pg_indexes where tablename='storage_cleanup_outbox' and indexname='idx_storage_cleanup_processing_lease'`,
    );
    expect(idx).toHaveLength(1);

    await pg.close();
  }, 60_000);
});
