// @vitest-environment node
/**
 * Phase 6 — Rigorous smoke & edge-case suite:
 * 1. Real Web Request/Response + ReadableStream wire transport across all Phase 6 endpoints
 * 2. Multi-tenant isolation, nonexistent vs unauthorized 404 symmetry, tricky filename Content-Disposition,
 *    SQL wildcard escaping, invalid query/pagination/method/CSRF/workspaceId rejection
 * 3. Streaming edge cases: 1-byte-per-chunk `%PDF-` signature + empty chunks, early truncation,
 *    oversized first/trailing chunks, non-PDF MIME override, raw B2 transport failure
 * 4. Concurrency & race stress: double single-doc delete, concurrent multi-doc deletes in same batch,
 *    delete vs active unexpired upload lease, delete vs expired lease + late commit orphan outbox,
 *    concurrent delete vs finalize
 * 5. Compiled Nitro Cloudflare Worker bundle (.output/server/index.mjs) verifying parent/child
 *    ApiDocumentsIdRoute dispatch across /api/documents/:id and /content, /upload, /cancel, /heartbeat
 * 6. Business review isolation invariant (review_status remains null across access & deletion)
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { claimDocumentUploadAttempt } from "@/lib/server/documents";
import { processCleanupOutbox } from "@/lib/server/lifecycle";
import type { SqlClient } from "@/lib/server/sql";
import { handleDeleteBatch, handleGetBatchDetail } from "@/routes/api.batches.$id";
import { handleFinalizeBatch } from "@/routes/api.batches.$id.finalize";
import { handleGetBatches, handlePostBatches } from "@/routes/api.batches";
import { handleCancelDocumentUpload } from "@/routes/api.documents.$id.cancel";
import { handleGetDocumentContent } from "@/routes/api.documents.$id.content";
import { handleHeartbeatDocumentUpload } from "@/routes/api.documents.$id.heartbeat";
import { handleDeleteDocument, handleGetDocumentDetail } from "@/routes/api.documents.$id";
import { handleUploadDocument } from "@/routes/api.documents.$id.upload";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const BUILT_WORKER_PATH = fileURLToPath(new URL("../../.output/server/index.mjs", import.meta.url));

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
  putInterceptor?:
    ((input: { key: string; body: ReadableStream<Uint8Array> }) => Promise<void>) | undefined;
  getInterceptor?: ((key: string) => Promise<B2GetObjectResult>) | undefined;
}

function createFakeB2(bucketName = "gathr-p6-smoke"): FakeB2Bucket {
  const objects = new Map<string, Uint8Array>();
  const deletedKeys: string[] = [];
  const state: FakeB2Bucket = {
    objects,
    deletedKeys,
    client: {
      bucketName,
      async putObject({ key, body }) {
        if (state.putInterceptor) {
          await state.putInterceptor({ key, body });
        }
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
              controller.enqueue(bytes);
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
    `%PDF-1.7\n% p6-smoke ${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`,
  );
}

const USER_A = {
  user: { id: "p6-smoke-a", name: "Kavya Rao", email: "kavya@example.com", emailVerified: true },
  session: { id: "p6-sess-a", userId: "p6-smoke-a" },
};

const USER_B = {
  user: { id: "p6-smoke-b", name: "Dev Patel", email: "dev@example.com", emailVerified: true },
  session: { id: "p6-sess-b", userId: "p6-smoke-b" },
};

describe("Phase 6 — Rigorous smoke & edge-case suite (Web HTTP + PGlite + Worker)", () => {
  const originUrl = "http://127.0.0.1:4173";
  let pg: PGlite;
  let sql: SqlClient;
  let b2: FakeB2Bucket;
  let workspaceAId = "";

  async function dispatchHttp(pathOrUrl: string, init?: RequestInit): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${originUrl}${pathOrUrl}`;
    const hasStreamBody =
      typeof ReadableStream !== "undefined" && init?.body instanceof ReadableStream;
    const reqInit: RequestInit & { duplex?: "half" } = {
      ...init,
      ...(hasStreamBody ? { duplex: "half" as const } : {}),
    };
    return await routeToHandler(new Request(url, reqInit));
  }

  async function routeToHandler(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/api/batches") {
      return request.method === "POST"
        ? await handlePostBatches(request)
        : await handleGetBatches(request);
    }
    if (/^\/api\/batches\/[^/]+\/finalize$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]!);
      return await handleFinalizeBatch(request, id, {
        sql,
        bucketName: b2.client.bucketName,
      });
    }
    if (/^\/api\/batches\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]!);
      return request.method === "GET"
        ? await handleGetBatchDetail(request, id)
        : await handleDeleteBatch(request, id, { sql, bucketName: b2.client.bucketName });
    }
    if (/^\/api\/documents\/[^/]+\/upload$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]!);
      return await handleUploadDocument(request, id, { sql, b2: b2.client });
    }
    if (/^\/api\/documents\/[^/]+\/heartbeat$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]!);
      return await handleHeartbeatDocumentUpload(request, id, { sql });
    }
    if (/^\/api\/documents\/[^/]+\/cancel$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]!);
      return await handleCancelDocumentUpload(request, id, { sql, b2: b2.client });
    }
    if (/^\/api\/documents\/[^/]+\/content$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]!);
      return await handleGetDocumentContent(request, id, { sql, b2: b2.client });
    }
    if (/^\/api\/documents\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]!);
      return request.method === "DELETE"
        ? await handleDeleteDocument(request, id, { sql, bucketName: b2.client.bucketName })
        : await handleGetDocumentDetail(request, id, { sql });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

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
       ('p6-smoke-a', 'Kavya Rao', 'kavya@example.com'),
       ('p6-smoke-b', 'Dev Patel', 'dev@example.com')`,
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

  async function createBatchHttp(
    name: string,
    files: Array<{ filename: string; sizeBytes: number }>,
  ) {
    const res = await dispatchHttp(`${originUrl}/api/batches`, {
      method: "POST",
      headers: { origin: originUrl, "content-type": "application/json" },
      body: JSON.stringify({ name, files }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      batch: { id: string; name: string; status: string; finalizedAt: string | null };
      documents: Array<{
        id: string;
        originalFilename: string;
        fileSizeBytes: number;
        status: string;
        reviewStatus: string | null;
      }>;
    };
    if (!workspaceAId) {
      const rows = await pg.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM batches WHERE id = $1::uuid`,
        [body.batch.id],
      );
      workspaceAId = rows.rows[0]!.workspace_id;
    }
    return body;
  }

  async function uploadPdfHttp(docId: string, bytes: Uint8Array): Promise<Response> {
    return await dispatchHttp(`${originUrl}/api/documents/${docId}/upload`, {
      method: "PUT",
      headers: {
        origin: originUrl,
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
      },
      body: bytes as unknown as BodyInit,
    });
  }

  it("Smoke 1: Full HTTP lifecycle (create -> upload -> reload -> metadata -> inline/download PDF -> single delete -> cleanup -> batch delete)", async () => {
    const pdf1 = makePdfBytes("wire-1");
    const pdf2 = makePdfBytes("wire-2-longer");
    const created = await createBatchHttp("Wire Smoke Batch", [
      { filename: "wire-one.pdf", sizeBytes: pdf1.byteLength },
      { filename: "wire-two.pdf", sizeBytes: pdf2.byteLength },
    ]);
    const [d1, d2] = created.documents;

    expect((await uploadPdfHttp(d1!.id, pdf1)).status).toBe(200);
    expect((await uploadPdfHttp(d2!.id, pdf2)).status).toBe(200);

    // Reload batch list & detail over HTTP dispatch
    const listRes = await dispatchHttp(`${originUrl}/api/batches`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { batches: Array<{ id: string }> };
    expect(listBody.batches.some((b) => b.id === created.batch.id)).toBe(true);

    const detailRes = await dispatchHttp(`${originUrl}/api/batches/${created.batch.id}`);
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      documents: Array<{ id: string; status: string; reviewStatus: null }>;
    };
    expect(detailBody.documents).toHaveLength(2);
    expect(detailBody.documents.every((d) => d.reviewStatus === null)).toBe(true);

    // Single document metadata endpoint over HTTP dispatch
    const docMetaRes = await dispatchHttp(`${originUrl}/api/documents/${d1!.id}`);
    expect(docMetaRes.status).toBe(200);
    const docMetaText = await docMetaRes.text();
    expect(docMetaText).not.toContain("storageKey");
    expect(docMetaText).not.toContain("gathr/");

    // Stream inline & attachment PDF over HTTP dispatch
    const inlineRes = await dispatchHttp(`${originUrl}/api/documents/${d1!.id}/content`);
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers.get("content-type")).toBe("application/pdf");
    expect(inlineRes.headers.get("cache-control")).toBe("private, no-store");
    expect(inlineRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(inlineRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(inlineRes.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(new Uint8Array(await inlineRes.arrayBuffer())).toEqual(pdf1);

    const dlRes = await dispatchHttp(`${originUrl}/api/documents/${d2!.id}/content?download=1`);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-disposition")).toContain("attachment;");
    expect(new Uint8Array(await dlRes.arrayBuffer())).toEqual(pdf2);

    // Delete single doc + verify cleanup outbox drains B2 object
    const delDocRes = await dispatchHttp(`${originUrl}/api/documents/${d1!.id}`, {
      method: "DELETE",
      headers: { origin: originUrl },
    });
    expect(delDocRes.status).toBe(200);
    const delDocBody = (await delDocRes.json()) as {
      deleted: boolean;
      cleanupJobsQueued: number;
      batch: { status: string };
    };
    expect(delDocBody.deleted).toBe(true);
    expect(delDocBody.cleanupJobsQueued).toBe(1);
    expect(delDocBody.batch.status).toBe("uploaded");

    expect((await dispatchHttp(`${originUrl}/api/documents/${d1!.id}`)).status).toBe(404);
    expect((await dispatchHttp(`${originUrl}/api/documents/${d1!.id}/content`)).status).toBe(404);

    const cleanup = await processCleanupOutbox(sql, b2.client);
    expect(cleanup.completed).toBe(1);
    expect(b2.objects.size).toBe(1);

    // Delete remaining batch + cleanup
    const delBatchRes = await dispatchHttp(`${originUrl}/api/batches/${created.batch.id}`, {
      method: "DELETE",
      headers: { origin: originUrl },
    });
    expect(delBatchRes.status).toBe(200);
    await processCleanupOutbox(sql, b2.client);
    expect(b2.objects.size).toBe(0);
  });

  it("Smoke 2: Filename Content-Disposition injection, wildcard escaping, pagination bounds, malformed IDs, and 404 symmetry", async () => {
    const pdf = makePdfBytes("tricky-name");

    // Ingress rejects path traversal / null-byte filenames before creation
    for (const badFilename of ["../escape.pdf", "bad\0name.pdf"]) {
      const badCreate = await dispatchHttp(`${originUrl}/api/batches`, {
        method: "POST",
        headers: { origin: originUrl, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Rejected Filename Batch",
          files: [{ filename: badFilename, sizeBytes: pdf.byteLength }],
        }),
      });
      expect(badCreate.status).toBe(400);
    }

    const trickyName = 'dir\\Rechnung — München "2026";\r\n\u202E-invoice.pdf';
    const created = await createBatchHttp("100%_Literal\\Batch", [
      { filename: trickyName, sizeBytes: pdf.byteLength },
    ]);
    const docId = created.documents[0]!.id;
    expect((await uploadPdfHttp(docId, pdf)).status).toBe(200);

    const dlRes = await dispatchHttp(`${originUrl}/api/documents/${docId}/content?download=1`);
    expect(dlRes.status).toBe(200);
    const cd = dlRes.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment;");
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).not.toContain("..");

    // Defense-in-depth even if a legacy DB row still holds raw control/quote/traversal chars
    await pg.query(`UPDATE documents SET original_filename = $1 WHERE id = $2::uuid`, [
      'legacy";\r\n..\\evil\u202E.pdf',
      docId,
    ]);
    const legacyDlRes = await dispatchHttp(
      `${originUrl}/api/documents/${docId}/content?download=1`,
    );
    expect(legacyDlRes.status).toBe(200);
    const legacyCd = legacyDlRes.headers.get("content-disposition") ?? "";
    expect(legacyCd).toContain("attachment;");
    expect(legacyCd).not.toMatch(/[\r\n]/);
    expect(legacyCd).not.toContain("..");
    expect(legacyCd).toContain("filename*=UTF-8''");

    // Wildcard search must escape %, _, and \ rather than matching unrelated batches
    const pctSearch = await dispatchHttp(
      `${originUrl}/api/batches?q=${encodeURIComponent("100%_Literal\\")}`,
    );
    expect(pctSearch.status).toBe(200);
    const pctBody = (await pctSearch.json()) as { batches: Array<{ id: string }> };
    expect(pctBody.batches.some((b) => b.id === created.batch.id)).toBe(true);

    const missWildcard = await dispatchHttp(
      `${originUrl}/api/batches?q=${encodeURIComponent("%_NO_MATCH_%")}`,
    );
    expect(missWildcard.status).toBe(200);
    expect(((await missWildcard.json()) as { batches: unknown[] }).batches).toEqual([]);

    // Invalid pagination / status / malformed UUIDs / workspaceId tampering
    for (const badPath of [
      "/api/batches?limit=0",
      "/api/batches?limit=101",
      "/api/batches?limit=abc",
      "/api/batches?offset=-1",
      "/api/batches?status=approved",
      "/api/batches?workspaceId=11111111-1111-4111-8111-111111111111",
      "/api/documents/not-a-uuid",
      `/api/documents/%20${docId}`,
      "/api/documents/1%20OR%201=1/content",
    ]) {
      const r = await dispatchHttp(`${originUrl}${badPath}`);
      expect(r.status).toBe(400);
    }

    // Tenant B vs nonexistent UUID response symmetry (status + body + headers)
    mocks.getSession.mockResolvedValue(USER_B);
    const fakeUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (const suffix of ["", "/content"]) {
      const cross = await dispatchHttp(`${originUrl}/api/documents/${docId}${suffix}`);
      const missing = await dispatchHttp(`${originUrl}/api/documents/${fakeUuid}${suffix}`);
      expect(cross.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await cross.text()).toBe(await missing.text());
      expect(cross.headers.get("cache-control")).toBe("private, no-store");
      expect(cross.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("Smoke 3: Streaming edge cases — 1-byte %PDF- chunks, empty chunks, truncated streams, oversized streams, MIME spoofing, and raw B2 errors", async () => {
    const pdf = makePdfBytes("chunked-stream");
    const created = await createBatchHttp("Stream Edge", [
      { filename: "stream.pdf", sizeBytes: pdf.byteLength },
    ]);
    const docId = created.documents[0]!.id;
    expect((await uploadPdfHttp(docId, pdf)).status).toBe(200);

    // 3a: Valid PDF delivered 1 byte at a time across the %PDF- header with empty chunks interspersed
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(0));
          for (let i = 0; i < 6; i++) {
            c.enqueue(pdf.subarray(i, i + 1));
            c.enqueue(new Uint8Array(0));
          }
          c.enqueue(pdf.subarray(6));
          c.close();
        },
      }),
      contentLength: pdf.byteLength,
      contentType: "application/pdf",
      etag: null,
    });
    const splitRes = await dispatchHttp(`${originUrl}/api/documents/${docId}/content`);
    expect(splitRes.status).toBe(200);
    expect(new Uint8Array(await splitRes.arrayBuffer())).toEqual(pdf);

    // 3b: 4-byte truncated header with null contentLength -> 502 before 200
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("%PDF"));
          c.close();
        },
      }),
      contentLength: null,
      contentType: "application/pdf",
      etag: null,
    });
    expect((await dispatchHttp(`${originUrl}/api/documents/${docId}/content`)).status).toBe(502);

    // 3c: First chunk exceeds declared size -> 502 DOCUMENT_CONTENT_MISMATCH before 200
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(pdf.byteLength + 20).fill(0x25));
          c.close();
        },
      }),
      contentLength: null,
      contentType: "application/pdf",
      etag: null,
    });
    const overFirst = await dispatchHttp(`${originUrl}/api/documents/${docId}/content`);
    expect(overFirst.status).toBe(502);
    expect(((await overFirst.json()) as { code: string }).code).toBe("DOCUMENT_CONTENT_MISMATCH");

    // 3d: 0-byte empty stream (null contentLength) -> pre-200 502 DOCUMENT_CONTENT_CORRUPT;
    //     mismatched declared B2 size -> pre-200 502 DOCUMENT_CONTENT_MISMATCH;
    //     >=5-byte short stream with null contentLength -> headers sent, body stream errors on premature EOF
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      contentLength: null,
      contentType: "application/pdf",
      etag: null,
    });
    const emptyStreamRes = await dispatchHttp(`${originUrl}/api/documents/${docId}/content`);
    expect(emptyStreamRes.status).toBe(502);
    expect(((await emptyStreamRes.json()) as { code: string }).code).toBe(
      "DOCUMENT_CONTENT_CORRUPT",
    );

    const shortChunk = new TextEncoder().encode("%PDF-1.7\n");
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(shortChunk);
          c.close();
        },
      }),
      contentLength: shortChunk.byteLength,
      contentType: "application/pdf",
      etag: null,
    });
    const sizeMismatchRes = await dispatchHttp(`${originUrl}/api/documents/${docId}/content`);
    expect(sizeMismatchRes.status).toBe(502);
    expect(((await sizeMismatchRes.json()) as { code: string }).code).toBe(
      "DOCUMENT_CONTENT_MISMATCH",
    );

    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(shortChunk);
          c.close();
        },
      }),
      contentLength: null,
      contentType: "application/pdf",
      etag: null,
    });
    await expect(
      dispatchHttp(`${originUrl}/api/documents/${docId}/content`).then((r) => r.arrayBuffer()),
    ).rejects.toThrow();

    // 3e: Mid-stream truncation after 200 headers (first chunk >=5 bytes, second closes short) -> stream errors cleanly
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(pdf.subarray(0, 10));
          setTimeout(() => {
            c.enqueue(pdf.subarray(10, 15));
            c.close();
          }, 5);
        },
      }),
      contentLength: null,
      contentType: "application/pdf",
      etag: null,
    });
    await expect(
      dispatchHttp(`${originUrl}/api/documents/${docId}/content`).then((r) => r.arrayBuffer()),
    ).rejects.toThrow();

    // 3f: Non-PDF MIME override even with %PDF- bytes -> 502 DOCUMENT_CONTENT_INVALID
    b2.getInterceptor = async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(pdf);
          c.close();
        },
      }),
      contentLength: pdf.byteLength,
      contentType: "text/plain; charset=utf-8",
      etag: null,
    });
    expect((await dispatchHttp(`${originUrl}/api/documents/${docId}/content`)).status).toBe(502);

    // 3g: Raw TypeError from B2 transport -> safe 502 STORAGE_UNAVAILABLE
    b2.getInterceptor = async () => {
      throw new TypeError("fetch failed: https://s3.us-west-004.backblazeb2.com/secret-bucket");
    };
    const rawErrRes = await dispatchHttp(`${originUrl}/api/documents/${docId}/content`);
    expect(rawErrRes.status).toBe(502);
    const rawErrText = await rawErrRes.text();
    expect(rawErrText).toContain("STORAGE_UNAVAILABLE");
    expect(rawErrText).not.toContain("secret-bucket");
    expect(rawErrText).not.toContain("backblazeb2.com");
  });

  it("Smoke 4: Concurrency & race stress (double delete, multi-doc concurrent delete, delete vs active/expired upload, delete vs finalize)", async () => {
    const pdf = makePdfBytes("race-doc");

    // 4a: Double DELETE on same document -> [200, 404], single outbox row
    const b1 = await createBatchHttp("Double Delete", [
      { filename: "dup-del-1.pdf", sizeBytes: pdf.byteLength },
      { filename: "dup-del-2.pdf", sizeBytes: pdf.byteLength },
    ]);
    expect((await uploadPdfHttp(b1.documents[0]!.id, pdf)).status).toBe(200);
    expect((await uploadPdfHttp(b1.documents[1]!.id, pdf)).status).toBe(200);

    const [delA, delB] = await Promise.all([
      dispatchHttp(`${originUrl}/api/documents/${b1.documents[0]!.id}`, {
        method: "DELETE",
        headers: { origin: originUrl },
      }),
      dispatchHttp(`${originUrl}/api/documents/${b1.documents[0]!.id}`, {
        method: "DELETE",
        headers: { origin: originUrl },
      }),
    ]);
    expect([delA.status, delB.status].sort()).toEqual([200, 404]);
    const outboxDup = await pg.query(
      `SELECT id FROM storage_cleanup_outbox WHERE document_id = $1::uuid`,
      [b1.documents[0]!.id],
    );
    expect(outboxDup.rows).toHaveLength(1);

    // 4b: Concurrent DELETE on two remaining docs in a 2-doc batch -> both succeed, batch status converges to 'failed' with 0 docs
    const b2Batch = await createBatchHttp("Concurrent Multi-Doc Delete", [
      { filename: "c1.pdf", sizeBytes: pdf.byteLength },
      { filename: "c2.pdf", sizeBytes: pdf.byteLength },
    ]);
    expect((await uploadPdfHttp(b2Batch.documents[0]!.id, pdf)).status).toBe(200);
    expect((await uploadPdfHttp(b2Batch.documents[1]!.id, pdf)).status).toBe(200);

    const [cDel1, cDel2] = await Promise.all([
      dispatchHttp(`${originUrl}/api/documents/${b2Batch.documents[0]!.id}`, {
        method: "DELETE",
        headers: { origin: originUrl },
      }),
      dispatchHttp(`${originUrl}/api/documents/${b2Batch.documents[1]!.id}`, {
        method: "DELETE",
        headers: { origin: originUrl },
      }),
    ]);
    expect(cDel1.status).toBe(200);
    expect(cDel2.status).toBe(200);
    const b2Detail = await (
      await dispatchHttp(`${originUrl}/api/batches/${b2Batch.batch.id}`)
    ).json();
    expect(b2Detail.documents).toEqual([]);
    expect(b2Detail.batch.status).toBe("failed");

    // 4c: Active unexpired upload blocks single-doc delete (409 UPLOAD_IN_PROGRESS); active upload finishes cleanly
    const b3Batch = await createBatchHttp("Active Upload Guard", [
      { filename: "active.pdf", sizeBytes: pdf.byteLength },
    ]);
    const activeDocId = b3Batch.documents[0]!.id;
    let enteredPut!: () => void;
    let releasePut!: () => void;
    const putEntered = new Promise<void>((r) => {
      enteredPut = r;
    });
    b2.putInterceptor = async () => {
      enteredPut();
      await new Promise<void>((r) => {
        releasePut = r;
      });
    };
    const activePutPromise = uploadPdfHttp(activeDocId, pdf);
    await putEntered;

    const blockedDelete = await dispatchHttp(`${originUrl}/api/documents/${activeDocId}`, {
      method: "DELETE",
      headers: { origin: originUrl },
    });
    expect(blockedDelete.status).toBe(409);
    expect(((await blockedDelete.json()) as { code: string }).code).toBe("UPLOAD_IN_PROGRESS");

    releasePut();
    b2.putInterceptor = undefined;
    expect((await activePutPromise).status).toBe(200);

    // 4d: Expired lease allows single-doc delete and queues expired attempt key as 'document_deleted'
    const b4Batch = await createBatchHttp("Expired Lease Delete", [
      { filename: "stale.pdf", sizeBytes: pdf.byteLength },
      { filename: "ready.pdf", sizeBytes: pdf.byteLength },
    ]);
    expect((await uploadPdfHttp(b4Batch.documents[1]!.id, pdf)).status).toBe(200);
    const staleClaim = await claimDocumentUploadAttempt(sql, {
      workspaceId: workspaceAId,
      documentId: b4Batch.documents[0]!.id,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf.byteLength,
      leaseSeconds: 5,
    });
    await pg.query(
      `UPDATE documents SET lease_expires_at = clock_timestamp() - interval '30 seconds' WHERE id = $1::uuid`,
      [b4Batch.documents[0]!.id],
    );

    const expiredDel = await dispatchHttp(
      `${originUrl}/api/documents/${b4Batch.documents[0]!.id}`,
      {
        method: "DELETE",
        headers: { origin: originUrl },
      },
    );
    expect(expiredDel.status).toBe(200);
    const expiredDelBody = (await expiredDel.json()) as {
      cleanupJobsQueued: number;
      batch: { status: string };
    };
    expect(expiredDelBody.cleanupJobsQueued).toBe(1);
    expect(expiredDelBody.batch.status).toBe("uploaded");

    const staleOutbox = await pg.query<{ storage_key: string; reason: string }>(
      `SELECT storage_key, reason FROM storage_cleanup_outbox WHERE document_id = $1::uuid`,
      [b4Batch.documents[0]!.id],
    );
    expect(staleOutbox.rows).toEqual([
      { storage_key: staleClaim.storageKey, reason: "document_deleted" },
    ]);

    // 4e: Concurrent DELETE /api/documents/:id vs POST /api/batches/:id/finalize -> deadlock-free [200, 409]
    const b5Batch = await createBatchHttp("Delete vs Finalize", [
      { filename: "one.pdf", sizeBytes: pdf.byteLength },
      { filename: "two.pdf", sizeBytes: pdf.byteLength },
    ]);
    expect((await uploadPdfHttp(b5Batch.documents[0]!.id, pdf)).status).toBe(200);
    expect((await uploadPdfHttp(b5Batch.documents[1]!.id, pdf)).status).toBe(200);

    const [raceDel, raceFin] = await Promise.all([
      dispatchHttp(`${originUrl}/api/documents/${b5Batch.documents[0]!.id}`, {
        method: "DELETE",
        headers: { origin: originUrl },
      }),
      dispatchHttp(`${originUrl}/api/batches/${b5Batch.batch.id}/finalize`, {
        method: "POST",
        headers: { origin: originUrl, "content-type": "application/json" },
        body: "{}",
      }),
    ]);
    expect([200, 409]).toContain(raceDel.status);
    expect([200, 409]).toContain(raceFin.status);
  });

  it("Smoke 5: Compiled Nitro Worker bundle dispatches /api/documents/:id AND all child /content, /upload, /cancel, /heartbeat routes", async () => {
    if (!existsSync(BUILT_WORKER_PATH)) return;

    const prevDbUrl = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      const mod = (await import(pathToFileURL(BUILT_WORKER_PATH).href)) as {
        default: {
          fetch: (req: Request, env: Record<string, unknown>, ctx: unknown) => Promise<Response>;
        };
      };

      const docUuid = "22222222-2222-4222-8222-222222222222";
      const dummyCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

      // Parent /api/batches route method guard
      const delBatches = await mod.default.fetch(
        new Request("https://app.test/api/batches", { method: "DELETE" }),
        {},
        dummyCtx,
      );
      expect(delBatches.status).toBe(405);
      expect(delBatches.headers.get("allow")).toBe("GET, POST");

      // Parent /api/documents/:id route methods & CSRF
      const postDoc = await mod.default.fetch(
        new Request(`https://app.test/api/documents/${docUuid}`, { method: "POST" }),
        {},
        dummyCtx,
      );
      expect(postDoc.status).toBe(405);
      expect(postDoc.headers.get("allow")).toBe("GET, DELETE");

      const csrfDelDoc = await mod.default.fetch(
        new Request(`https://app.test/api/documents/${docUuid}`, {
          method: "DELETE",
          headers: { origin: "https://evil.example" },
        }),
        {},
        dummyCtx,
      );
      expect(csrfDelDoc.status).toBe(403);

      const getDoc = await mod.default.fetch(
        new Request(`https://app.test/api/documents/${docUuid}`),
        {},
        dummyCtx,
      );
      expect([401, 500, 503]).toContain(getDoc.status);
      expect(getDoc.status).not.toBe(404);

      // Verify child routes under ApiDocumentsIdRoute are NEVER swallowed by parent /api/documents/$id
      const postContent = await mod.default.fetch(
        new Request(`https://app.test/api/documents/${docUuid}/content`, { method: "POST" }),
        {},
        dummyCtx,
      );
      expect(postContent.status).toBe(405);
      expect(postContent.headers.get("allow")).toBe("GET");

      const getUpload = await mod.default.fetch(
        new Request(`https://app.test/api/documents/${docUuid}/upload`, { method: "GET" }),
        {},
        dummyCtx,
      );
      expect(getUpload.status).toBe(405);
      expect(getUpload.headers.get("allow")).toBe("PUT");

      const getCancel = await mod.default.fetch(
        new Request(`https://app.test/api/documents/${docUuid}/cancel`, { method: "GET" }),
        {},
        dummyCtx,
      );
      expect(getCancel.status).toBe(405);
      expect(getCancel.headers.get("allow")).toBe("POST");

      const getHeartbeat = await mod.default.fetch(
        new Request(`https://app.test/api/documents/${docUuid}/heartbeat`, { method: "GET" }),
        {},
        dummyCtx,
      );
      expect(getHeartbeat.status).toBe(405);
      expect(getHeartbeat.headers.get("allow")).toBe("POST");
    } finally {
      if (prevDbUrl !== undefined) {
        process.env["DATABASE_URL"] = prevDbUrl;
      }
    }
  }, 30_000);
});
