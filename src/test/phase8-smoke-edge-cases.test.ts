// @vitest-environment node
/**
 * Phase 8 — Rigorous smoke & edge-case tests for Export and Data Portability.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEDGER_TABLE_SQL,
  runMigrations,
  type MigrationDb,
} from "../../scripts/lib/migrate-core.mjs";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSql: vi.fn(),
}));

vi.mock("@tanstack/react-start/server-only", () => ({}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: vi.fn(() => new Headers()),
  setResponseHeader: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@/lib/server/sql", () => ({
  getSql: (...args: unknown[]) => mocks.getSql(...args),
}));

import {
  B2ObjectNotFoundError,
  B2StorageError,
  type B2StorageClient,
} from "@/lib/server/b2-storage";
import type { SqlClient } from "@/lib/server/sql";
import { handlePostBatches } from "@/routes/api.batches";
import { handleUploadDocument } from "@/routes/api.documents.$id.upload";
import { handlePostExport } from "@/routes/api.exports";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const BUILT_WORKER_PATH = fileURLToPath(new URL("../../.output/server/index.mjs", import.meta.url));
const ORIGIN = "https://gathr.example.test";

function pgliteMigrationAdapter(pg: PGlite): MigrationDb {
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

function makePgSqlClient(pg: PGlite): SqlClient {
  return {
    query: async (text, params = []) => {
      const result = await pg.query<Record<string, unknown>>(text, params);
      return result.rows;
    },
  };
}

function makeMemoryB2(): {
  b2: B2StorageClient;
  objects: Map<string, Uint8Array>;
  storageErrors: Map<string, Error>;
} {
  const objects = new Map<string, Uint8Array>();
  const storageErrors = new Map<string, Error>();
  const b2: B2StorageClient = {
    bucketName: "gathr-smoke-bucket",
    async putObject({ key, body }) {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      objects.set(key, out);
      return { etag: `"etag-${key}"` };
    },
    async getObject({ key }) {
      const forcedErr = storageErrors.get(key);
      if (forcedErr) throw forcedErr;
      if (!objects.has(key)) {
        throw new B2ObjectNotFoundError(`Missing object ${key}`);
      }
      const bytes = objects.get(key)!;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentLength: bytes.byteLength,
        contentType: "application/pdf",
        etag: `"etag-${key}"`,
      };
    },
    async deleteObject({ key }) {
      return { deleted: objects.delete(key) };
    },
  };
  return { b2, objects, storageErrors };
}

function makePdfBytes(tag: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% ${tag}\n%%EOF\n`);
}

function authedUser(id: string, name: string, email: string) {
  mocks.getSession.mockResolvedValue({
    session: { id: `sess-${id}`, userId: id },
    user: { id, name, email },
  });
}

describe("Phase 8 — Rigorous smoke & edge-case tests", () => {
  let pg: PGlite;
  let sql: SqlClient;

  beforeAll(async () => {
    pg = new PGlite();
    const res = await runMigrations({
      db: pgliteMigrationAdapter(pg),
      dir: MIGRATIONS_DIR,
      mode: "apply",
    });
    expect(res.ok).toBe(true);
    sql = makePgSqlClient(pg);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getSql.mockReturnValue(sql);
    await pg.exec(`
      TRUNCATE TABLE
        "document_review_events",
        "documents",
        "batches",
        "workspaces",
        "user"
      RESTART IDENTITY CASCADE;
    `);
    await pg.query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified")
       VALUES
         ('smoke-a', 'Smoke User A', 'smoke-a@example.com', true),
         ('smoke-b', 'Smoke User B', 'smoke-b@example.com', true)`,
    );
  });

  it("1. Rejects bad methods, unauthenticated requests, invalid payloads, and oversized JSON cleanly without 500s", async () => {
    // Bad methods
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await handlePostExport(new Request(`${ORIGIN}/api/exports`, { method }), { sql });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }

    // Unauthenticated
    mocks.getSession.mockResolvedValue(null);
    const unauthRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "csv", scope: "workspace" }),
      }),
      { sql },
    );
    expect(unauthRes.status).toBe(401);

    // Invalid payloads when authenticated
    authedUser("smoke-a", "Smoke User A", "smoke-a@example.com");

    const badBodies: unknown[] = [
      { format: "xml", scope: "workspace" },
      { format: "csv", scope: "invalid" },
      { format: "csv", scope: "batch" },
      { format: "csv", scope: "batch", batchId: "not-a-uuid" },
      { format: "csv", scope: "workspace", documentIds: ["bad-uuid"] },
      { format: "csv", scope: "workspace", reviewScope: "everything" },
      { format: "csv", scope: "workspace", uploadStatus: "bogus" },
    ];

    for (const body of badBodies) {
      const res = await handlePostExport(
        new Request(`${ORIGIN}/api/exports`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ORIGIN },
          body: JSON.stringify(body),
        }),
        { sql },
      );
      expect(res.status).toBe(400);
    }

    // Oversized JSON (>256 KiB)
    const hugeBody = JSON.stringify({
      format: "csv",
      scope: "workspace",
      query: "a".repeat(300 * 1024),
    });
    const hugeRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: hugeBody,
      }),
      { sql },
    );
    expect(hugeRes.status).toBe(413);
  });

  it("2. Handles mixed upload states, corrupt B2 objects, and transient B2 503 errors in ZIP without leaking internals", async () => {
    const { b2, objects, storageErrors } = makeMemoryB2();
    authedUser("smoke-a", "Smoke User A", "smoke-a@example.com");

    const createRes = await handlePostBatches(
      new Request(`${ORIGIN}/api/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          name: "Edge Case ZIP Batch",
          files: [
            {
              filename: "valid.pdf",
              mimeType: "application/pdf",
              sizeBytes: makePdfBytes("ok").byteLength,
            },
            {
              filename: "corrupt.pdf",
              mimeType: "application/pdf",
              sizeBytes: makePdfBytes("corrupt").byteLength,
            },
            {
              filename: "unavailable.pdf",
              mimeType: "application/pdf",
              sizeBytes: makePdfBytes("unavail").byteLength,
            },
            {
              filename: "still_pending.pdf",
              mimeType: "application/pdf",
              sizeBytes: makePdfBytes("pending").byteLength,
            },
          ],
        }),
      }),
      { sql },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      batch: { id: string };
      documents: Array<{ id: string; originalFilename: string }>;
    };

    // Upload first 3 documents, leave 4th as pending_upload
    for (let i = 0; i < 3; i++) {
      const doc = created.documents[i]!;
      const tag = i === 0 ? "ok" : i === 1 ? "corrupt" : "unavail";
      const bytes = makePdfBytes(tag);
      const upRes = await handleUploadDocument(
        new Request(`${ORIGIN}/api/documents/${doc.id}/upload`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(bytes.byteLength),
            Origin: ORIGIN,
          },
          body: bytes as unknown as BodyInit,
        }),
        doc.id,
        { sql, b2 },
      );
      expect(upRes.status).toBe(200);
    }

    const keyRows = await sql.query(
      `SELECT "id", "storage_key" FROM "documents" WHERE "batch_id" = $1::uuid`,
      [created.batch.id],
    );
    const keyById = new Map(keyRows.map((r) => [String(r["id"]), String(r["storage_key"])]));

    // Corrupt 2nd doc's stored bytes (same byte length, non-PDF magic)
    const corruptKey = keyById.get(created.documents[1]!.id)!;
    const corruptBytes = new TextEncoder().encode(
      "<html>not a pdf at all!!</html>".slice(0, makePdfBytes("corrupt").byteLength),
    );
    objects.set(corruptKey, corruptBytes);

    // Force B2 503 on 3rd doc
    const unavailKey = keyById.get(created.documents[2]!.id)!;
    storageErrors.set(
      unavailKey,
      new B2StorageError(
        503,
        "B2 internal endpoint https://s3.us-west-004.backblazeb2.com timeout",
        "ServiceUnavailable",
        true,
      ),
    );

    const zipRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "zip", scope: "batch", batchId: created.batch.id }),
      }),
      { sql, b2 },
    );

    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("X-Gathr-Export-Status")).toBe("partial");
    expect(zipRes.headers.get("X-Gathr-Export-Included-Count")).toBe("1");
    expect(zipRes.headers.get("X-Gathr-Export-Failed-Count")).toBe("3");

    const zip = await JSZip.loadAsync(await zipRes.arrayBuffer());
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      status: string;
      includedPdfCount: number;
      failedCount: number;
      failures: Array<{ filename: string; code: string; reason: string }>;
    };
    expect(manifest.status).toBe("partial");
    expect(manifest.includedPdfCount).toBe(1);
    expect(manifest.failedCount).toBe(3);

    const codes = new Set(manifest.failures.map((f) => f.code));
    expect(codes).toEqual(
      new Set(["OBJECT_CORRUPT", "STORAGE_UNAVAILABLE", "DOCUMENT_NOT_UPLOADED"]),
    );

    // Ensure internal B2 endpoint / storage keys are never leaked in manifest or ERRORS.txt
    const errorsTxt = await zip.file("ERRORS.txt")!.async("string");
    expect(errorsTxt).not.toContain("backblazeb2.com");
    expect(errorsTxt).not.toContain(corruptKey);
    expect(errorsTxt).not.toContain(unavailKey);
  });

  it("3. Escapes SQL LIKE wildcards in search query and intersects documentIds with workspace ownership", async () => {
    const { b2 } = makeMemoryB2();

    // Workspace B creates a doc
    authedUser("smoke-b", "Smoke User B", "smoke-b@example.com");
    const bBatchRes = await handlePostBatches(
      new Request(`${ORIGIN}/api/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          name: "B Batch",
          files: [{ filename: "b_100%_secret.pdf", mimeType: "application/pdf", sizeBytes: 100 }],
        }),
      }),
      { sql },
    );
    const bBatch = (await bBatchRes.json()) as { documents: Array<{ id: string }> };

    // Workspace A creates 2 docs: one with literal "100%_tax" and one normal
    authedUser("smoke-a", "Smoke User A", "smoke-a@example.com");
    const aBatchRes = await handlePostBatches(
      new Request(`${ORIGIN}/api/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          name: "A Batch",
          files: [
            { filename: "invoice_100%_tax.pdf", mimeType: "application/pdf", sizeBytes: 100 },
            { filename: "invoice_regular.pdf", mimeType: "application/pdf", sizeBytes: 100 },
          ],
        }),
      }),
      { sql },
    );
    const aBatch = (await aBatchRes.json()) as { documents: Array<{ id: string }> };

    // Search for literal "100%_" should match only invoice_100%_tax.pdf, not invoice_regular.pdf
    const likeRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "csv", scope: "workspace", query: "100%_" }),
      }),
      { sql, b2 },
    );
    expect(likeRes.status).toBe(200);
    expect(likeRes.headers.get("X-Gathr-Export-Included-Count")).toBe("1");
    const likeCsv = await likeRes.text();
    expect(likeCsv).toContain("invoice_100%_tax.pdf");
    expect(likeCsv).not.toContain("invoice_regular.pdf");

    // Passing mixed documentIds [ownId, foreignId] exports only ownId
    const mixedRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          format: "csv",
          scope: "workspace",
          documentIds: [aBatch.documents[0]!.id, bBatch.documents[0]!.id],
        }),
      }),
      { sql, b2 },
    );
    expect(mixedRes.status).toBe(200);
    expect(mixedRes.headers.get("X-Gathr-Export-Included-Count")).toBe("1");
    const mixedCsv = await mixedRes.text();
    expect(mixedCsv).not.toContain("b_100%_secret.pdf");
  });

  it("4. Compiled Nitro Worker dispatches POST /api/exports cleanly", async () => {
    if (!existsSync(BUILT_WORKER_PATH)) {
      throw new Error(
        `Built Nitro worker not found at ${BUILT_WORKER_PATH}. Run npm run build first.`,
      );
    }
    const mod = (await import(pathToFileURL(BUILT_WORKER_PATH).href)) as {
      default: {
        fetch: (
          req: Request,
          env: Record<string, unknown>,
          ctx: { waitUntil: () => void; passThroughOnException: () => void },
        ) => Promise<Response>;
      };
    };
    const workerCtx = { waitUntil() {}, passThroughOnException() {} };

    const getRes = await mod.default.fetch(
      new Request("https://gathr.example.test/api/exports", { method: "GET" }),
      {},
      workerCtx,
    );
    expect(getRes.status).toBe(405);

    const postRes = await mod.default.fetch(
      new Request("https://gathr.example.test/api/exports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://gathr.example.test",
        },
        body: JSON.stringify({ format: "csv", scope: "workspace" }),
      }),
      {},
      workerCtx,
    );
    expect([401, 503]).toContain(postRes.status);
  });
});
