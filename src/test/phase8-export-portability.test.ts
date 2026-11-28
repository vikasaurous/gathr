// @vitest-environment node
/**
 * Phase 8 — Export and data portability acceptance checks (1–8).
 */
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import JSZip from "jszip";
import * as XLSX from "xlsx";
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
  buildSafePersistedPdfName,
  persistedDocumentsToCsv,
  persistedDocumentsToPdfReport,
  persistedDocumentsToXlsx,
} from "@/lib/gathr/export";
import { B2ObjectNotFoundError, type B2StorageClient } from "@/lib/server/b2-storage";
import type { SqlClient } from "@/lib/server/sql";
import { handlePostBatches } from "@/routes/api.batches";
import { handleReviewDocument } from "@/routes/api.documents.$id.review";
import { handleUploadDocument } from "@/routes/api.documents.$id.upload";
import { handlePostExport } from "@/routes/api.exports";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
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

function makeMemoryB2(missingKeys = new Set<string>()): {
  b2: B2StorageClient;
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  const b2: B2StorageClient = {
    bucketName: "gathr-test-bucket",
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
      if (missingKeys.has(key) || !objects.has(key)) {
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
      const existed = objects.delete(key);
      return { deleted: existed };
    },
  };
  return { b2, objects };
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

async function createAndUploadBatch(
  sql: SqlClient,
  b2: B2StorageClient,
  batchName: string,
  files: Array<{ filename: string; pdfTag: string }>,
) {
  const createRes = await handlePostBatches(
    new Request(`${ORIGIN}/api/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        name: batchName,
        files: files.map((f) => ({
          filename: f.filename,
          mimeType: "application/pdf",
          sizeBytes: makePdfBytes(f.pdfTag).byteLength,
        })),
      }),
    }),
    { sql },
  );
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as {
    batch: { id: string; name: string };
    documents: Array<{ id: string; originalFilename: string }>;
  };

  for (let i = 0; i < created.documents.length; i++) {
    const doc = created.documents[i]!;
    const bytes = makePdfBytes(files[i]!.pdfTag);
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

  return created;
}

describe("Phase 8 — Export and data portability", () => {
  let pg: PGlite;
  let sql: SqlClient;

  beforeAll(async () => {
    pg = new PGlite();
    const migRes = await runMigrations({
      db: pgliteMigrationAdapter(pg),
      dir: MIGRATIONS_DIR,
      mode: "apply",
    });
    expect(migRes.ok).toBe(true);
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
         ('user-a', 'Aarav Sharma', 'aarav@example.com', true),
         ('user-b', 'Meera Nair', 'meera@example.com', true)`,
    );
  });

  it("1 & 2 & 3. Exports CSV, XLSX, PDF, and ZIP matching contract with safe entry names and no cross-workspace leakage", async () => {
    const { b2 } = makeMemoryB2();

    // Seed Workspace B first
    authedUser("user-b", "Meera Nair", "meera@example.com");
    const batchB = await createAndUploadBatch(sql, b2, "Workspace B Secret Batch", [
      { filename: "secret_b_invoice.pdf", pdfTag: "secret-b" },
    ]);

    // Seed Workspace A with colliding filenames, path-traversal attempt, Unicode, and formula prefix
    authedUser("user-a", "Aarav Sharma", "aarav@example.com");
    const batchA = await createAndUploadBatch(sql, b2, "October, GST & Unicode ₹", [
      { filename: "vendor_alpha.pdf", pdfTag: "alpha-1" },
      { filename: "vendor_alpha.pdf", pdfTag: "alpha-2" },
      { filename: "evil=cmd(1).pdf", pdfTag: "evil-traversal" },
    ]);
    await sql.query(`UPDATE "documents" SET "original_filename" = $1 WHERE "id" = $2::uuid`, [
      "../../evil=cmd(1).pdf",
      batchA.documents[2]!.id,
    ]);

    // Mark doc 0 as verified, doc 1 as needs_review, doc 2 left unreviewed
    const rev1 = await handleReviewDocument(
      new Request(`${ORIGIN}/api/documents/${batchA.documents[0]!.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ reviewStatus: "verified", expectedReviewVersion: 0 }),
      }),
      batchA.documents[0]!.id,
      { sql },
    );
    expect(rev1.status).toBe(200);

    const rev2 = await handleReviewDocument(
      new Request(`${ORIGIN}/api/documents/${batchA.documents[1]!.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ reviewStatus: "needs_review", expectedReviewVersion: 0 }),
      }),
      batchA.documents[1]!.id,
      { sql },
    );
    expect(rev2.status).toBe(200);

    // 1. CSV export
    const csvRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "csv", scope: "batch", batchId: batchA.batch.id }),
      }),
      { sql, b2 },
    );
    expect(csvRes.status).toBe(200);
    const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
    expect(Array.from(csvBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csvText = new TextDecoder().decode(csvBytes);
    expect(csvText).toContain("Document ID,Filename,Batch,Batch ID,Upload status,Review status");
    expect(csvText).toContain("Verified");
    expect(csvText).toContain("Needs review");
    expect(csvText).toContain("Unreviewed");
    expect(csvText).not.toContain("secret_b_invoice.pdf");
    expect(csvText).not.toContain("storage_key");

    // 2. XLSX export
    const xlsxRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "xlsx", scope: "batch", batchId: batchA.batch.id }),
      }),
      { sql, b2 },
    );
    expect(xlsxRes.status).toBe(200);
    const wb = XLSX.read(new Uint8Array(await xlsxRes.arrayBuffer()), { type: "array" });
    expect(wb.SheetNames).toEqual(["Documents"]);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Documents"]!);
    expect(rows).toHaveLength(3);

    // 3. PDF report export
    const pdfRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "pdf", scope: "batch", batchId: batchA.batch.id }),
      }),
      { sql, b2 },
    );
    expect(pdfRes.status).toBe(200);
    const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe("%PDF-");

    // 4. ZIP export
    const zipRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "zip", scope: "batch", batchId: batchA.batch.id }),
      }),
      { sql, b2 },
    );
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("X-Gathr-Export-Status")).toBe("complete");
    expect(zipRes.headers.get("X-Gathr-Export-Included-Count")).toBe("3");

    const zip = await JSZip.loadAsync(await zipRes.arrayBuffer());
    const entryNames = Object.keys(zip.files).filter((k) => !zip.files[k]!.dir);
    expect(entryNames).toContain("documents.csv");
    expect(entryNames).toContain("manifest.json");
    expect(entryNames).not.toContain("ERRORS.txt");

    const pdfEntries = entryNames.filter((n) => n.startsWith("documents/") && n.endsWith(".pdf"));
    expect(pdfEntries).toHaveLength(3);
    for (const entry of pdfEntries) {
      expect(entry).not.toContain("..");
    }

    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      status: string;
      includedPdfCount: number;
      failedCount: number;
    };
    expect(manifest.status).toBe("complete");
    expect(manifest.includedPdfCount).toBe(3);
    expect(manifest.failedCount).toBe(0);

    // 5. Cross-workspace isolation checks
    const crossBatchRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "csv", scope: "batch", batchId: batchB.batch.id }),
      }),
      { sql, b2 },
    );
    expect(crossBatchRes.status).toBe(404);

    const crossWsParamRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          format: "csv",
          scope: "workspace",
          workspaceId: "00000000-0000-4000-8000-000000000000",
        }),
      }),
      { sql, b2 },
    );
    expect(crossWsParamRes.status).toBe(400);

    // 6. Verify reviewScope=verified_only includes only verified doc
    const verifiedRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          format: "csv",
          scope: "workspace",
          reviewScope: "verified_only",
        }),
      }),
      { sql, b2 },
    );
    expect(verifiedRes.status).toBe(200);
    expect(verifiedRes.headers.get("X-Gathr-Export-Included-Count")).toBe("1");
  });

  it("4. Handles commas, quotes, newlines, Unicode, and formula prefixes safely across formats", async () => {
    const sampleDocs = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        batchId: "22222222-2222-4222-8222-222222222222",
        batchName: 'Batch "Q4"\nहिन्दी ₹1,000',
        originalFilename: "=CMD|' /C calc'!A0.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1024,
        status: "uploaded" as const,
        reviewStatus: "verified" as const,
        uploadedAt: "2026-11-27T10:00:00Z",
        reviewUpdatedAt: "2026-11-27T10:05:00Z",
        createdAt: "2026-11-27T09:59:00Z",
      },
    ];

    const csv = persistedDocumentsToCsv(sampleDocs);
    expect(csv).toContain("'=CMD|' /C calc'!A0.pdf");
    expect(csv).toContain('"Batch ""Q4""\nहिन्दी ₹1,000"');

    const xlsxBytes = persistedDocumentsToXlsx(sampleDocs);
    const wb = XLSX.read(xlsxBytes, { type: "array" });
    const ws = wb.Sheets["Documents"]!;
    expect(ws["B2"]?.t).toBe("s");
    expect(ws["B2"]?.v).toBe("=CMD|' /C calc'!A0.pdf");
    expect(ws["B2"]?.f).toBeUndefined();
    expect(ws["H2"]?.t).toBe("n");
    expect(ws["H2"]?.v).toBe(1024);

    const pdfBytes = await persistedDocumentsToPdfReport(sampleDocs);
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe("%PDF-");

    const safeEntry = buildSafePersistedPdfName("../../evil\\name:?.pdf", "doc-1");
    expect(safeEntry).not.toContain("..");
    expect(safeEntry).not.toContain("/");
    expect(safeEntry).not.toContain("\\");
    expect(safeEntry.endsWith(".pdf")).toBe(true);
  });

  it("5 & 7. Reports missing B2 object in ZIP as partial (or 422 when all fail) and leaves DB state unchanged", async () => {
    const missingKeys = new Set<string>();
    const { b2 } = makeMemoryB2(missingKeys);

    authedUser("user-a", "Aarav Sharma", "aarav@example.com");
    const batch = await createAndUploadBatch(sql, b2, "Missing Object Batch", [
      { filename: "good_invoice.pdf", pdfTag: "good-pdf" },
      { filename: "missing_invoice.pdf", pdfTag: "missing-pdf" },
    ]);

    // Query storage_key of second doc directly in test DB to simulate missing B2 object
    const keyRows = await sql.query(
      `SELECT "id", "storage_key" FROM "documents" WHERE "batch_id" = $1::uuid ORDER BY "original_filename" ASC`,
      [batch.batch.id],
    );
    const missingDocRow = keyRows.find((r) => r["id"] === batch.documents[1]!.id)!;
    missingKeys.add(String(missingDocRow["storage_key"]));

    // Snapshot DB state before export
    const beforeDocs = await sql.query(
      `SELECT "id", "status", "review_status", "review_version" FROM "documents" WHERE "batch_id" = $1::uuid ORDER BY "id"`,
      [batch.batch.id],
    );

    // Partial failure: 1 succeeds, 1 missing
    const partialRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "zip", scope: "batch", batchId: batch.batch.id }),
      }),
      { sql, b2 },
    );
    expect(partialRes.status).toBe(200);
    expect(partialRes.headers.get("X-Gathr-Export-Status")).toBe("partial");
    expect(partialRes.headers.get("X-Gathr-Export-Included-Count")).toBe("1");
    expect(partialRes.headers.get("X-Gathr-Export-Failed-Count")).toBe("1");

    const partialZip = await JSZip.loadAsync(await partialRes.arrayBuffer());
    expect(partialZip.file("ERRORS.txt")).not.toBeNull();
    const errorsTxt = await partialZip.file("ERRORS.txt")!.async("string");
    expect(errorsTxt).toContain("missing_invoice.pdf");
    expect(errorsTxt).toContain("OBJECT_MISSING");
    expect(errorsTxt).not.toContain(String(missingDocRow["storage_key"]));

    const manifest = JSON.parse(await partialZip.file("manifest.json")!.async("string")) as {
      status: string;
      failedCount: number;
      failures: Array<{ filename: string; code: string }>;
    };
    expect(manifest.status).toBe("partial");
    expect(manifest.failedCount).toBe(1);
    expect(manifest.failures[0]?.code).toBe("OBJECT_MISSING");

    // Total failure: mark first doc missing too -> must return 422, not an empty ZIP
    const goodDocRow = keyRows.find((r) => r["id"] === batch.documents[0]!.id)!;
    missingKeys.add(String(goodDocRow["storage_key"]));

    const totalFailRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ format: "zip", scope: "batch", batchId: batch.batch.id }),
      }),
      { sql, b2 },
    );
    expect(totalFailRes.status).toBe(422);
    const totalFailBody = (await totalFailRes.json()) as {
      code: string;
      failures: Array<{ code: string }>;
    };
    expect(totalFailBody.code).toBe("EXPORT_NO_DOCUMENTS_AVAILABLE");
    expect(totalFailBody.failures).toHaveLength(2);

    // Read-only invariant: DB rows unchanged
    const afterDocs = await sql.query(
      `SELECT "id", "status", "review_status", "review_version" FROM "documents" WHERE "batch_id" = $1::uuid ORDER BY "id"`,
      [batch.batch.id],
    );
    expect(afterDocs).toEqual(beforeDocs);
  });

  it("8. Rejects GET method and cross-origin requests", async () => {
    const getRes = await handlePostExport(new Request(`${ORIGIN}/api/exports`, { method: "GET" }), {
      sql,
    });
    expect(getRes.status).toBe(405);

    authedUser("user-a", "Aarav Sharma", "aarav@example.com");
    const csrfRes = await handlePostExport(
      new Request(`${ORIGIN}/api/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ format: "csv", scope: "workspace" }),
      }),
      { sql },
    );
    expect(csrfRes.status).toBe(403);
  });
});
