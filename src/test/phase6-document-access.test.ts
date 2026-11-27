// @vitest-environment node
/**
 * Phase 6 — Document access & management acceptance checks (1–8).
 *
 * Exercises workspace-scoped listing, single-document metadata retrieval,
 * streaming private PDF delivery & integrity guards, cross-workspace and
 * nonexistent ID non-leakage, single-document deletion with atomic cleanup
 * outbox guarantees, and batch deletion against real PGlite migrations +
 * mocked B2 storage transport.
 */
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
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
  type B2GetObjectResult,
  type B2StorageClient,
} from "@/lib/server/b2-storage";
import { processCleanupOutbox } from "@/lib/server/lifecycle";
import type { SqlClient } from "@/lib/server/sql";
import { handleDeleteBatch, handleGetBatchDetail } from "@/routes/api.batches.$id";
import { handleFinalizeBatch } from "@/routes/api.batches.$id.finalize";
import { handleGetBatches, handlePostBatches } from "@/routes/api.batches";
import { handleGetDocumentContent } from "@/routes/api.documents.$id.content";
import { handleDeleteDocument, handleGetDocumentDetail } from "@/routes/api.documents.$id";
import { handleUploadDocument } from "@/routes/api.documents.$id.upload";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

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

async function readStreamAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

interface FakeB2Bucket {
  objects: Map<string, Uint8Array>;
  deletedKeys: string[];
  client: B2StorageClient;
  getInterceptor?: ((key: string) => Promise<B2GetObjectResult>) | undefined;
}

function createFakeB2(bucketName = "gathr-p6-test"): FakeB2Bucket {
  const objects = new Map<string, Uint8Array>();
  const deletedKeys: string[] = [];
  const state: FakeB2Bucket = {
    objects,
    deletedKeys,
    client: {
      bucketName,
      async putObject({ key, body }) {
        const bytes = await readStreamAll(body);
        objects.set(key, bytes);
        return { etag: `"etag-${bytes.byteLength}"` };
      },
      async getObject({ key }) {
        if (state.getInterceptor) {
          return await state.getInterceptor(key);
        }
        const bytes = objects.get(key);
        if (!bytes) {
          throw new B2ObjectNotFoundError();
        }
        return {
          body: new ReadableStream({
            start(controller) {
              // Emit across two chunks to test streaming header inspection + forwarding
              const mid = Math.max(1, Math.min(3, bytes.byteLength));
              controller.enqueue(bytes.subarray(0, mid));
              if (mid < bytes.byteLength) {
                controller.enqueue(bytes.subarray(mid));
              }
              controller.close();
            },
          }),
          contentLength: bytes.byteLength,
          contentType: "application/pdf",
          etag: `"etag-${bytes.byteLength}"`,
        };
      },
      async deleteObject({ key }) {
        deletedKeys.push(key);
        return { deleted: objects.delete(key) };
      },
    },
  };
  return state;
}

function makePdfBytes(tag: string): Uint8Array {
  return new TextEncoder().encode(
    `%PDF-1.7\n% phase6 ${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`,
  );
}

const USER_A = {
  user: { id: "user-p6-a", name: "Meera Nair", email: "meera@example.com", emailVerified: true },
  session: { id: "sess-p6-a", userId: "user-p6-a" },
};

const USER_B = {
  user: { id: "user-p6-b", name: "Arjun Sen", email: "arjun@example.com", emailVerified: true },
  session: { id: "sess-p6-b", userId: "user-p6-b" },
};

describe("Phase 6 — Document access, private streaming, and lifecycle management", () => {
  let pg: PGlite;
  let sql: SqlClient;
  let b2: FakeB2Bucket;

  beforeAll(async () => {
    pg = new PGlite();
    const res = await runMigrations({
      db: pgliteMigrationAdapter(pg),
      dir: MIGRATIONS_DIR,
      mode: "apply",
    });
    expect(res.ok).toBe(true);
    await pg.exec(
      `INSERT INTO "user"(id, name, email) VALUES
       ('user-p6-a', 'Meera Nair', 'meera@example.com'),
       ('user-p6-b', 'Arjun Sen', 'arjun@example.com')`,
    );
    sql = makePgSqlClient(pg);
  }, 90_000);

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(() => {
    b2 = createFakeB2();
    mocks.getSql.mockReturnValue(sql);
    mocks.getSession.mockResolvedValue(USER_A);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  async function createBatch(name: string, files: Array<{ filename: string; sizeBytes: number }>) {
    const res = await handlePostBatches(
      new Request("https://app.test/api/batches", {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json" },
        body: JSON.stringify({ name, files }),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as {
      batch: { id: string; name: string; status: string };
      documents: Array<{
        id: string;
        originalFilename: string;
        fileSizeBytes: number;
        status: string;
      }>;
    };
  }

  async function uploadPdf(documentId: string, bytes: Uint8Array) {
    const res = await handleUploadDocument(
      new Request(`https://app.test/api/documents/${documentId}/upload`, {
        method: "PUT",
        headers: {
          origin: "https://app.test",
          "content-type": "application/pdf",
          "content-length": String(bytes.byteLength),
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      documentId,
      { sql, b2: b2.client },
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  it("1–3 & 7. Enforces workspace-scoped batch/document listing, reload recovery, PDF byte streaming, and zero private field leakage", async () => {
    const pdfOne = makePdfBytes("alpha");
    const pdfTwo = makePdfBytes("beta-unicode-invoice");

    // Workspace A creates two batches
    const batchA1 = await createBatch("November Invoices", [
      { filename: "alpha.pdf", sizeBytes: pdfOne.byteLength },
      { filename: "pending-doc.pdf", sizeBytes: pdfTwo.byteLength },
    ]);
    await uploadPdf(batchA1.documents[0]!.id, pdfOne);

    const batchA2 = await createBatch("Q4 Archive — Łódź", [
      { filename: "faktura — Łódź.pdf", sizeBytes: pdfTwo.byteLength },
    ]);
    await uploadPdf(batchA2.documents[0]!.id, pdfTwo);

    // Workspace B creates a separate batch
    mocks.getSession.mockResolvedValue(USER_B);
    const batchB = await createBatch("Tenant B Batch", [
      { filename: "secret-b.pdf", sizeBytes: pdfOne.byteLength },
    ]);
    await uploadPdf(batchB.documents[0]!.id, pdfOne);

    // Acceptance check 1: Workspace A only sees its own batches & documents
    mocks.getSession.mockResolvedValue(USER_A);
    const listAllA = await handleGetBatches(new Request("https://app.test/api/batches"));
    expect(listAllA.status).toBe(200);
    const listAllBody = await listAllA.json();
    expect(listAllBody.batches.map((b: { id: string }) => b.id)).toEqual([
      batchA2.batch.id,
      batchA1.batch.id,
    ]);

    // Filter & pagination query support
    const filteredList = await handleGetBatches(
      new Request("https://app.test/api/batches?status=uploaded&q=Archive&limit=10&offset=0"),
    );
    expect(filteredList.status).toBe(200);
    const filteredBody = await filteredList.json();
    expect(filteredBody.batches).toHaveLength(1);
    expect(filteredBody.batches[0].id).toBe(batchA2.batch.id);

    const badFilter = await handleGetBatches(
      new Request("https://app.test/api/batches?status=approved"),
    );
    expect(badFilter.status).toBe(400);

    // Acceptance check 2: Reload reconstruction via GET /api/batches/:id and GET /api/documents/:id
    const detailRes = await handleGetBatchDetail(
      new Request(`https://app.test/api/batches/${batchA1.batch.id}`),
      batchA1.batch.id,
    );
    expect(detailRes.status).toBe(200);
    const detailText = await detailRes.text();
    const detailBody = JSON.parse(detailText);
    expect(
      detailBody.documents.map((d: { id: string; status: string }) => [d.id, d.status]),
    ).toEqual([
      [batchA1.documents[0]!.id, "uploaded"],
      [batchA1.documents[1]!.id, "pending_upload"],
    ]);

    const docDetailRes = await handleGetDocumentDetail(
      new Request(`https://app.test/api/documents/${batchA2.documents[0]!.id}`),
      batchA2.documents[0]!.id,
      { sql },
    );
    expect(docDetailRes.status).toBe(200);
    expect(docDetailRes.headers.get("cache-control")).toBe("private, no-store");
    expect(docDetailRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(docDetailRes.headers.get("referrer-policy")).toBe("no-referrer");

    const docDetailText = await docDetailRes.text();
    const docDetailBody = JSON.parse(docDetailText);
    expect(docDetailBody.document.id).toBe(batchA2.documents[0]!.id);
    expect(docDetailBody.document.status).toBe("uploaded");
    expect(docDetailBody.document.reviewStatus).toBeNull();
    expect(docDetailBody.batch.id).toBe(batchA2.batch.id);

    // Acceptance check 7: Private storage fields & credentials absent from client-facing responses
    for (const payloadText of [detailText, docDetailText]) {
      expect(payloadText).not.toContain("storageKey");
      expect(payloadText).not.toContain("storage_key");
      expect(payloadText).not.toContain("gathr/");
      expect(payloadText).not.toContain("bucketName");
      expect(payloadText).not.toContain("activeAttemptId");
      expect(payloadText).not.toContain("B2_");
      expect(payloadText).not.toContain("applicationKey");
    }

    // Acceptance check 3: Stream inline and attachment PDFs with exact bytes and private headers
    const inlineRes = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${batchA1.documents[0]!.id}/content`),
      batchA1.documents[0]!.id,
      { sql, b2: b2.client },
    );
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers.get("content-type")).toBe("application/pdf");
    expect(inlineRes.headers.get("content-disposition")).toContain("inline;");
    expect(inlineRes.headers.get("cache-control")).toBe("private, no-store");
    expect(inlineRes.headers.get("pragma")).toBe("no-cache");
    expect(inlineRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(inlineRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(inlineRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(inlineRes.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(inlineRes.headers.get("content-length")).toBe(String(pdfOne.byteLength));
    expect(new Uint8Array(await inlineRes.arrayBuffer())).toEqual(pdfOne);

    const downloadRes = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${batchA2.documents[0]!.id}/content?download=1`),
      batchA2.documents[0]!.id,
      { sql, b2: b2.client },
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-disposition")).toContain("attachment;");
    expect(downloadRes.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(new Uint8Array(await downloadRes.arrayBuffer())).toEqual(pdfTwo);
  });

  it("4 & 5. Cross-workspace and nonexistent document IDs return identical safe 404 responses without metadata leakage", async () => {
    const pdf = makePdfBytes("tenant-a-secret");
    const batchA = await createBatch("Private A", [
      { filename: "private-a.pdf", sizeBytes: pdf.byteLength },
    ]);
    await uploadPdf(batchA.documents[0]!.id, pdf);
    const ownedDocId = batchA.documents[0]!.id;
    const missingDocId = "99999999-9999-4999-8999-999999999999";

    // User B tries to access User A's document vs a guessed nonexistent UUID
    mocks.getSession.mockResolvedValue(USER_B);

    const crossDetail = await handleGetDocumentDetail(
      new Request(`https://app.test/api/documents/${ownedDocId}`),
      ownedDocId,
      { sql },
    );
    const missingDetail = await handleGetDocumentDetail(
      new Request(`https://app.test/api/documents/${missingDocId}`),
      missingDocId,
      { sql },
    );
    expect(crossDetail.status).toBe(404);
    expect(missingDetail.status).toBe(404);
    expect(await crossDetail.json()).toEqual(await missingDetail.json());

    const crossContent = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${ownedDocId}/content`),
      ownedDocId,
      { sql, b2: b2.client },
    );
    const missingContent = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${missingDocId}/content`),
      missingDocId,
      { sql, b2: b2.client },
    );
    expect(crossContent.status).toBe(404);
    expect(missingContent.status).toBe(404);
    expect(await crossContent.json()).toEqual(await missingContent.json());

    const crossDelete = await handleDeleteDocument(
      new Request(`https://app.test/api/documents/${ownedDocId}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      ownedDocId,
      { sql, bucketName: b2.client.bucketName },
    );
    const missingDelete = await handleDeleteDocument(
      new Request(`https://app.test/api/documents/${missingDocId}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      missingDocId,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(crossDelete.status).toBe(404);
    expect(missingDelete.status).toBe(404);
    expect(await crossDelete.json()).toEqual(await missingDelete.json());

    // Unauthenticated, cross-origin, wrong method, client workspaceId rejected
    const badOriginDel = await handleDeleteDocument(
      new Request(`https://app.test/api/documents/${ownedDocId}`, {
        method: "DELETE",
        headers: { origin: "https://evil.test" },
      }),
      ownedDocId,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(badOriginDel.status).toBe(403);

    const wrongMethod = await handleGetDocumentDetail(
      new Request(`https://app.test/api/documents/${ownedDocId}`, { method: "POST" }),
      ownedDocId,
      { sql },
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, DELETE");

    const clientWsInject = await handleGetDocumentDetail(
      new Request(
        `https://app.test/api/documents/${ownedDocId}?workspaceId=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa`,
      ),
      ownedDocId,
      { sql },
    );
    expect(clientWsInject.status).toBe(400);

    mocks.getSession.mockResolvedValue(null);
    const unauth = await handleGetDocumentDetail(
      new Request(`https://app.test/api/documents/${ownedDocId}`),
      ownedDocId,
      { sql },
    );
    expect(unauth.status).toBe(401);
  });

  it("6. Rejects missing, 0-byte, size-mismatched, non-PDF, and transient B2 errors without returning 200 empty or unrelated content", async () => {
    const pdf = makePdfBytes("integrity-check");
    const batch = await createBatch("Integrity", [
      { filename: "good.pdf", sizeBytes: pdf.byteLength },
      { filename: "unstarted.pdf", sizeBytes: pdf.byteLength },
    ]);
    await uploadPdf(batch.documents[0]!.id, pdf);
    const docId = batch.documents[0]!.id;
    const unstartedId = batch.documents[1]!.id;

    // Pending/unuploaded document -> 409
    const notUploaded = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${unstartedId}/content`),
      unstartedId,
      { sql, b2: b2.client },
    );
    expect(notUploaded.status).toBe(409);

    // 6a: B2 missing object (NoSuchKey / 404) -> 404 DOCUMENT_CONTENT_MISSING
    b2.getInterceptor = async () => {
      throw new B2StorageError(404, "NoSuchKey", "NoSuchKey", false);
    };
    const missingObj = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${docId}/content`),
      docId,
      { sql, b2: b2.client },
    );
    expect(missingObj.status).toBe(404);
    expect((await missingObj.json()).code).toBe("DOCUMENT_CONTENT_MISSING");

    // 6b: Transient B2 error (503) -> 502 STORAGE_UNAVAILABLE without leaking storage keys
    b2.getInterceptor = async () => {
      throw new B2StorageError(503, "ServiceUnavailable", "ServiceUnavailable", true);
    };
    const transientErr = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${docId}/content`),
      docId,
      { sql, b2: b2.client },
    );
    expect(transientErr.status).toBe(502);
    const transientText = await transientErr.text();
    expect(transientText).toContain("STORAGE_UNAVAILABLE");
    expect(transientText).not.toContain("gathr/");

    // 6c: Empty 0-byte object in B2 -> 502 DOCUMENT_CONTENT_CORRUPT (never 200)
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      contentLength: 0,
      contentType: "application/pdf",
      etag: null,
    });
    const emptyObj = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${docId}/content`),
      docId,
      { sql, b2: b2.client },
    );
    expect(emptyObj.status).toBe(502);
    expect((await emptyObj.json()).code).toBe("DOCUMENT_CONTENT_CORRUPT");

    // 6d: Size mismatch -> 502 DOCUMENT_CONTENT_MISMATCH
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("%PDF-1.7\nshort"));
          c.close();
        },
      }),
      contentLength: 14,
      contentType: "application/pdf",
      etag: null,
    });
    const sizeMismatch = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${docId}/content`),
      docId,
      { sql, b2: b2.client },
    );
    expect(sizeMismatch.status).toBe(502);
    expect((await sizeMismatch.json()).code).toBe("DOCUMENT_CONTENT_MISMATCH");

    // 6e: Unrelated HTML content masquerading in B2 (even with null contentLength) -> 502 DOCUMENT_CONTENT_INVALID
    const htmlPayload = new TextEncoder().encode("<html><body>Not a PDF</body></html>");
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(htmlPayload);
          c.close();
        },
      }),
      contentLength: null,
      contentType: "text/html",
      etag: null,
    });
    const htmlObj = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${docId}/content`),
      docId,
      { sql, b2: b2.client },
    );
    expect(htmlObj.status).toBe(502);
    expect((await htmlObj.json()).code).toBe("DOCUMENT_CONTENT_INVALID");

    // 6f: Non-PDF bytes even with application/pdf MIME -> 502 DOCUMENT_CONTENT_INVALID
    const fakePdf = new Uint8Array(pdf.byteLength).fill(0x41); // 'AAAA...'
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(fakePdf);
          c.close();
        },
      }),
      contentLength: fakePdf.byteLength,
      contentType: "application/pdf",
      etag: null,
    });
    const invalidSig = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${docId}/content`),
      docId,
      { sql, b2: b2.client },
    );
    expect(invalidSig.status).toBe(502);
    expect((await invalidSig.json()).code).toBe("DOCUMENT_CONTENT_INVALID");
  });

  it("8. Deletes individual documents and whole batches atomically with Phase 5 outbox cleanup guarantees", async () => {
    const pdf1 = makePdfBytes("del-doc-1");
    const pdf2 = makePdfBytes("del-doc-2");
    const batch = await createBatch("Delete Lifecycle", [
      { filename: "doc1.pdf", sizeBytes: pdf1.byteLength },
      { filename: "doc2.pdf", sizeBytes: pdf2.byteLength },
    ]);
    await uploadPdf(batch.documents[0]!.id, pdf1);
    const doc1Id = batch.documents[0]!.id;
    const doc2Id = batch.documents[1]!.id;

    // Deleting an uploaded document when bucketName is empty must roll back atomically
    const missingBucketDel = await handleDeleteDocument(
      new Request(`https://app.test/api/documents/${doc1Id}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      doc1Id,
      { sql, bucketName: "" },
    );
    expect(missingBucketDel.status).toBe(500);
    const stillExists = await handleGetDocumentDetail(
      new Request(`https://app.test/api/documents/${doc1Id}`),
      doc1Id,
      { sql },
    );
    expect(stillExists.status).toBe(200);

    // Deleting doc2 (pending_upload) leaves doc1 (uploaded) -> batch transitions from uploading -> uploaded
    const delDoc2 = await handleDeleteDocument(
      new Request(`https://app.test/api/documents/${doc2Id}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      doc2Id,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(delDoc2.status).toBe(200);
    const delDoc2Body = await delDoc2.json();
    expect(delDoc2Body.deleted).toBe(true);
    expect(delDoc2Body.cleanupJobsQueued).toBe(0);
    expect(delDoc2Body.batch.status).toBe("uploaded");

    // Deleting uploaded doc1 persists 'document_deleted' outbox obligation and recomputes batch status
    const delDoc1 = await handleDeleteDocument(
      new Request(`https://app.test/api/documents/${doc1Id}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      doc1Id,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(delDoc1.status).toBe(200);
    const delDoc1Body = await delDoc1.json();
    expect(delDoc1Body.deleted).toBe(true);
    expect(delDoc1Body.cleanupJobsQueued).toBe(1);
    expect(delDoc1Body.batch.status).toBe("failed");

    const outboxRows = await pg.query<{ storage_key: string; reason: string; status: string }>(
      `SELECT storage_key, reason, status FROM storage_cleanup_outbox WHERE document_id = $1::uuid`,
      [doc1Id],
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect(outboxRows.rows[0]?.reason).toBe("document_deleted");
    expect(outboxRows.rows[0]?.status).toBe("pending");
    const targetKey = outboxRows.rows[0]!.storage_key;
    expect(b2.objects.has(targetKey)).toBe(true);

    // Cleanup worker drains 'document_deleted' obligation from B2
    const cleanupResult = await processCleanupOutbox(sql, b2.client);
    expect(cleanupResult.completed).toBe(1);
    expect(b2.objects.has(targetKey)).toBe(false);

    // Finalized batch rejects single-document deletion (409 BATCH_FINALIZED), while DELETE /api/batches/:id succeeds
    const sealedBatch = await createBatch("Sealed Batch", [
      { filename: "keep.pdf", sizeBytes: pdf1.byteLength },
    ]);
    await uploadPdf(sealedBatch.documents[0]!.id, pdf1);
    const finRes = await handleFinalizeBatch(
      new Request(`https://app.test/api/batches/${sealedBatch.batch.id}/finalize`, {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json" },
        body: "{}",
      }),
      sealedBatch.batch.id,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(finRes.status).toBe(200);

    const blockedDocDel = await handleDeleteDocument(
      new Request(`https://app.test/api/documents/${sealedBatch.documents[0]!.id}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      sealedBatch.documents[0]!.id,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(blockedDocDel.status).toBe(409);
    expect((await blockedDocDel.json()).code).toBe("BATCH_FINALIZED");

    const batchDel = await handleDeleteBatch(
      new Request(`https://app.test/api/batches/${sealedBatch.batch.id}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      sealedBatch.batch.id,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(batchDel.status).toBe(200);
    const afterBatchDel = await handleGetBatchDetail(
      new Request(`https://app.test/api/batches/${sealedBatch.batch.id}`),
      sealedBatch.batch.id,
    );
    expect(afterBatchDel.status).toBe(404);
  });
});
