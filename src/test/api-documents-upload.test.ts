// @vitest-environment node
/**
 * Phase 4 — Secure PDF ingestion and storage acceptance checks (1–9)
 * against PGlite + committed migrations + mocked Backblaze B2 S3 transport.
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

import { MAX_FILE_BYTES } from "@/lib/gathr/ingestion-types";
import {
  B2ObjectNotFoundError,
  B2StorageError,
  type B2StorageClient,
} from "@/lib/server/b2-storage";
import { claimDocumentUploadAttempt, commitDocumentUploadAttempt } from "@/lib/server/documents";
import type { SqlClient } from "@/lib/server/sql";
import { handleGetBatchDetail } from "@/routes/api.batches.$id";
import { handlePostBatches } from "@/routes/api.batches";
import { handleCancelDocumentUpload } from "@/routes/api.documents.$id.cancel";
import { handleGetDocumentContent } from "@/routes/api.documents.$id.content";
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

interface FakeB2Bucket {
  objects: Map<string, Uint8Array>;
  putCalls: Array<{ key: string; size: number }>;
  deletedKeys: string[];
  client: B2StorageClient;
  putInterceptor?:
    | ((input: {
        key: string;
        body: ReadableStream<Uint8Array>;
        contentLength: number;
        signal?: AbortSignal | undefined;
      }) => Promise<void>)
    | undefined;
}

async function readStreamAll(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException("Aborted", "AbortError");
      }
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

function createFakeB2(bucketName = "gathr-private-test"): FakeB2Bucket {
  const objects = new Map<string, Uint8Array>();
  const putCalls: Array<{ key: string; size: number }> = [];
  const deletedKeys: string[] = [];

  const state: FakeB2Bucket = {
    objects,
    putCalls,
    deletedKeys,
    putInterceptor: undefined,
    client: {
      bucketName,
      async putObject({ key, body, contentLength, signal }) {
        putCalls.push({ key, size: contentLength });
        if (state.putInterceptor) {
          await state.putInterceptor({ key, body, contentLength, signal });
        }
        const bytes = await readStreamAll(body, signal);
        objects.set(key, bytes);
        return { etag: `"etag-${bytes.byteLength}"` };
      },
      async getObject({ key }) {
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

const USER_A = {
  user: { id: "user-p4-a", name: "Maya Iyer", email: "maya@example.com", emailVerified: true },
  session: { id: "sess-p4-a", userId: "user-p4-a" },
};

const USER_B = {
  user: { id: "user-p4-b", name: "Karan Mehta", email: "karan@example.com", emailVerified: true },
  session: { id: "sess-p4-b", userId: "user-p4-b" },
};

function makePdfBytes(tag: string): Uint8Array {
  return new TextEncoder().encode(
    `%PDF-1.7\n% synthetic ${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`,
  );
}

function makeUploadRequest(
  documentId: string,
  bytes: Uint8Array | ReadableStream<Uint8Array> | null,
  options?: {
    method?: string;
    origin?: string;
    contentType?: string;
    contentLength?: string | null;
    signal?: AbortSignal;
    query?: string;
  },
): Request {
  const headers: Record<string, string> = {
    origin: options?.origin ?? "https://app.test",
  };
  if (options?.contentType !== undefined) {
    if (options.contentType !== "") headers["content-type"] = options.contentType;
  } else {
    headers["content-type"] = "application/pdf";
  }

  if (options?.contentLength !== null) {
    if (options?.contentLength !== undefined) {
      headers["content-length"] = options.contentLength;
    } else if (bytes instanceof Uint8Array) {
      headers["content-length"] = String(bytes.byteLength);
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: options?.method ?? "PUT",
    headers,
    ...(options?.signal ? { signal: options.signal } : {}),
  };

  if (bytes !== null) {
    init.body =
      bytes instanceof Uint8Array
        ? new ReadableStream({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          })
        : bytes;
    init.duplex = "half";
  }

  return new Request(
    `https://app.test/api/documents/${documentId}/upload${options?.query ?? ""}`,
    init,
  );
}

async function createPersistedBatch(
  files: Array<{ filename: string; sizeBytes: number }>,
  name = "Phase 4 Test Batch",
) {
  const res = await handlePostBatches(
    new Request("https://app.test/api/batches", {
      method: "POST",
      headers: {
        origin: "https://app.test",
        "content-type": "application/json",
        "idempotency-key": globalThis.crypto.randomUUID(),
      },
      body: JSON.stringify({ name, files }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    batch: { id: string; status: string };
    documents: Array<{
      id: string;
      originalFilename: string;
      fileSizeBytes: number;
      status: string;
    }>;
  };
}

describe("Phase 4 — Secure PDF ingestion and storage (PGlite + fake B2)", () => {
  let pg: PGlite;
  let sql: SqlClient;
  let b2: FakeB2Bucket;

  beforeAll(async () => {
    pg = new PGlite();
    const migrated = await runMigrations({
      db: pgliteMigrationAdapter(pg),
      dir: MIGRATIONS_DIR,
      mode: "apply",
    });
    expect(migrated.ok).toBe(true);
    await pg.exec(
      `INSERT INTO "user"(id, name, email) VALUES
       ('user-p4-a', 'Maya Iyer', 'maya@example.com'),
       ('user-p4-b', 'Karan Mehta', 'karan@example.com')`,
    );
    sql = makePgSqlClient(pg);
  }, 90_000);

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getSql.mockReturnValue(sql);
    b2 = createFakeB2();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("1 & 2 & 8 & 9. Uploads single and multiple PDFs to distinct private B2 objects, excludes storage keys/secrets from responses, and enforces authorized private retrieval", async () => {
    mocks.getSession.mockResolvedValue(USER_A);

    const pdfOne = makePdfBytes("invoice-one");
    const pdfTwo = makePdfBytes("invoice-two-longer-payload");

    const created = await createPersistedBatch([
      { filename: "inv-01.pdf", sizeBytes: pdfOne.byteLength },
      { filename: "inv-02.pdf", sizeBytes: pdfTwo.byteLength },
    ]);
    const [doc1, doc2] = created.documents;
    expect(doc1).toBeDefined();
    expect(doc2).toBeDefined();

    // Chunked stream split directly across the %PDF- header bytes to verify boundary safety
    const splitPdfOneStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pdfOne.subarray(0, 2)); // "%P"
        controller.enqueue(pdfOne.subarray(2, 5)); // "DF-"
        controller.enqueue(pdfOne.subarray(5));
        controller.close();
      },
    });

    const upload1Res = await handleUploadDocument(
      makeUploadRequest(doc1!.id, splitPdfOneStream, {
        contentLength: String(pdfOne.byteLength),
      }),
      doc1!.id,
      { sql, b2: b2.client },
    );
    expect(upload1Res.status).toBe(200);
    const upload1Text = await upload1Res.text();

    // Acceptance check 8: no private keys, bucket name, or B2 credentials in responses
    expect(upload1Text).not.toContain("storageKey");
    expect(upload1Text).not.toContain("storage_key");
    expect(upload1Text).not.toContain("gathr/");
    expect(upload1Text).not.toContain("gathr-private-test");
    expect(upload1Text).not.toContain("B2_");

    const upload1Body = JSON.parse(upload1Text);
    expect(upload1Body.document.status).toBe("uploaded");
    expect(upload1Body.document.reviewStatus).toBeNull();
    expect(upload1Body.batch.status).toBe("uploading"); // doc2 is still pending_upload

    const upload2Res = await handleUploadDocument(makeUploadRequest(doc2!.id, pdfTwo), doc2!.id, {
      sql,
      b2: b2.client,
    });
    expect(upload2Res.status).toBe(200);
    const upload2Body = await upload2Res.json();
    expect(upload2Body.document.status).toBe("uploaded");
    expect(upload2Body.batch.status).toBe("uploaded");

    // Verify DB records have distinct storage keys matching attempt-specific paths and exact byte sizes
    const dbDocs = await pg.query<{
      id: string;
      storage_key: string;
      file_size_bytes: string;
      status: string;
      review_status: string | null;
    }>(
      `SELECT id, storage_key, file_size_bytes::text, status, review_status
       FROM documents WHERE id IN ($1::uuid, $2::uuid)`,
      [doc1!.id, doc2!.id],
    );
    expect(dbDocs.rows).toHaveLength(2);
    const key1 = dbDocs.rows.find((r) => r.id === doc1!.id)!.storage_key;
    const key2 = dbDocs.rows.find((r) => r.id === doc2!.id)!.storage_key;
    expect(key1).not.toBe(key2);
    expect(key1).toMatch(new RegExp(`^gathr/[^/]+/${created.batch.id}/${doc1!.id}/[^/]+\\.pdf$`));
    expect(key2).toMatch(new RegExp(`^gathr/[^/]+/${created.batch.id}/${doc2!.id}/[^/]+\\.pdf$`));
    expect(b2.objects.get(key1)).toEqual(pdfOne);
    expect(b2.objects.get(key2)).toEqual(pdfTwo);

    // Acceptance check 9: private retrieval requires authorized session and workspace ownership
    mocks.getSession.mockResolvedValueOnce(null);
    const unauthContent = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${doc1!.id}/content`),
      doc1!.id,
      { sql, b2: b2.client },
    );
    expect(unauthContent.status).toBe(401);

    mocks.getSession.mockResolvedValueOnce(USER_B);
    const crossTenantContent = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${doc1!.id}/content`),
      doc1!.id,
      { sql, b2: b2.client },
    );
    expect(crossTenantContent.status).toBe(404);

    // Authorized retrieval streams exact bytes with private/no-store + nosniff headers
    mocks.getSession.mockResolvedValue(USER_A);
    const inlineRes = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${doc1!.id}/content`),
      doc1!.id,
      { sql, b2: b2.client },
    );
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers.get("content-type")).toBe("application/pdf");
    expect(inlineRes.headers.get("cache-control")).toBe("private, no-store");
    expect(inlineRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(inlineRes.headers.get("content-disposition")).toContain("inline;");
    expect(inlineRes.headers.get("content-disposition")).toContain('filename="inv-01.pdf"');
    const fetchedBytes = new Uint8Array(await inlineRes.arrayBuffer());
    expect(fetchedBytes).toEqual(pdfOne);

    const downloadRes = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${doc2!.id}/content?download=1`),
      doc2!.id,
      { sql, b2: b2.client },
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-disposition")).toContain("attachment;");
  });

  it("3. Rejects invalid HTTP method, MIME, missing/incorrect size, non-PDF/malformed signature, truncated stream, and oversized payload without marking uploaded", async () => {
    mocks.getSession.mockResolvedValue(USER_A);

    const validPdf = makePdfBytes("check3");
    const created = await createPersistedBatch([
      { filename: "check3.pdf", sizeBytes: validPdf.byteLength },
    ]);
    const docId = created.documents[0]!.id;

    // Wrong HTTP method -> 405
    const wrongMethod = await handleUploadDocument(
      makeUploadRequest(docId, validPdf, { method: "POST" }),
      docId,
      { sql, b2: b2.client },
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("PUT");

    // Cross-origin -> 403
    const crossOrigin = await handleUploadDocument(
      makeUploadRequest(docId, validPdf, { origin: "https://evil.test" }),
      docId,
      { sql, b2: b2.client },
    );
    expect(crossOrigin.status).toBe(403);

    // Wrong MIME type -> 415 with Connection: close so HTTP/1.1 sockets never keep unread body
    const wrongMime = await handleUploadDocument(
      makeUploadRequest(docId, validPdf, { contentType: "text/plain" }),
      docId,
      { sql, b2: b2.client },
    );
    expect(wrongMime.status).toBe(415);
    expect(wrongMime.headers.get("connection")).toBe("close");

    // Missing Content-Length -> 411
    const missingSize = await handleUploadDocument(
      makeUploadRequest(docId, validPdf, { contentLength: null }),
      docId,
      { sql, b2: b2.client },
    );
    expect(missingSize.status).toBe(411);

    // Mismatched declared size -> 400
    const wrongSize = await handleUploadDocument(
      makeUploadRequest(docId, validPdf, { contentLength: String(validPdf.byteLength + 10) }),
      docId,
      { sql, b2: b2.client },
    );
    expect(wrongSize.status).toBe(400);

    // Over 50 MiB declared -> 413
    const tooLargeDeclared = await handleUploadDocument(
      makeUploadRequest(docId, validPdf, { contentLength: String(MAX_FILE_BYTES + 1) }),
      docId,
      { sql, b2: b2.client },
    );
    expect(tooLargeDeclared.status).toBe(413);

    // Non-PDF payload (same length, invalid magic bytes) -> 400 before B2 write
    const fakePayload = new Uint8Array(validPdf.byteLength).fill(0x41);
    const nonPdf = await handleUploadDocument(makeUploadRequest(docId, fakePayload), docId, {
      sql,
      b2: b2.client,
    });
    expect(nonPdf.status).toBe(400);
    expect((await nonPdf.json()).code).toBe("INVALID_PDF_SIGNATURE");
    expect(b2.putCalls).toHaveLength(0);

    // Malformed short PDF signature ("%PDF") -> 400
    const malformedShort = new TextEncoder().encode("%PDF");
    const malformedBatch = await createPersistedBatch([
      { filename: "short.pdf", sizeBytes: malformedShort.byteLength },
    ]);
    const shortRes = await handleUploadDocument(
      makeUploadRequest(malformedBatch.documents[0]!.id, malformedShort),
      malformedBatch.documents[0]!.id,
      { sql, b2: b2.client },
    );
    expect(shortRes.status).toBe(400);

    // Truncated stream (starts with %PDF-, streams partial bytes across 2 chunks, then closes early)
    const truncatedStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(validPdf.subarray(0, 10));
      },
      pull(c) {
        c.close();
      },
    });
    const truncRes = await handleUploadDocument(
      makeUploadRequest(docId, truncatedStream, { contentLength: String(validPdf.byteLength) }),
      docId,
      { sql, b2: b2.client },
    );
    expect(truncRes.status).toBe(400);
    expect((await truncRes.json()).code).toBe("TRUNCATED_STREAM");

    // Oversized body lying about Content-Length (streams extra bytes past declared length)
    const extraBytes = new Uint8Array(validPdf.byteLength + 50);
    extraBytes.set(validPdf, 0);
    const lieStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(validPdf.subarray(0, 8));
      },
      pull(c) {
        c.enqueue(extraBytes.subarray(8));
        c.close();
      },
    });
    const overBodyRes = await handleUploadDocument(
      makeUploadRequest(docId, lieStream, { contentLength: String(validPdf.byteLength) }),
      docId,
      { sql, b2: b2.client },
    );
    expect(overBodyRes.status).toBe(400);
    expect((await overBodyRes.json()).code).toBe("SIZE_MISMATCH");

    // Verify document was never marked uploaded and content endpoint refuses retrieval
    const detailRes = await handleGetBatchDetail(
      new Request(`https://app.test/api/batches/${created.batch.id}`),
      created.batch.id,
    );
    const detail = await detailRes.json();
    expect(detail.documents[0].status).toBe("failed");

    const contentAttempt = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${docId}/content`),
      docId,
      { sql, b2: b2.client },
    );
    expect(contentAttempt.status).toBe(409);
  });

  it("4 & 5. Enforces distinct object keys, active lease fencing, and fences late expired attempts from overwriting or deleting newer attempts", async () => {
    mocks.getSession.mockResolvedValue(USER_A);

    const payloadOld = makePdfBytes("attempt-old");
    const payloadNew = makePdfBytes("attempt-new-different-bytes");
    expect(payloadOld.byteLength).not.toBe(payloadNew.byteLength);

    // Use same byte length for valid two-attempt replacement on same document
    const bytesV1 = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n(old-attempt-bytes)\nendobj\n");
    const bytesV2 = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n(new-attempt-bytes)\nendobj\n");
    expect(bytesV1.byteLength).toBe(bytesV2.byteLength);

    const created = await createPersistedBatch([
      { filename: "race.pdf", sizeBytes: bytesV1.byteLength },
    ]);
    const docId = created.documents[0]!.id;
    const wsRows = await pg.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM documents WHERE id = $1::uuid`,
      [docId],
    );
    const workspaceId = wsRows.rows[0]!.workspace_id;

    // 4a: Claim attempt 1 -> active unexpired attempt blocks concurrent claim with 409
    const claim1 = await claimDocumentUploadAttempt(sql, {
      workspaceId,
      documentId: docId,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: bytesV1.byteLength,
      leaseSeconds: 60,
    });

    await expect(
      claimDocumentUploadAttempt(sql, {
        workspaceId,
        documentId: docId,
        bucketName: b2.client.bucketName,
        declaredSizeBytes: bytesV1.byteLength,
        leaseSeconds: 60,
      }),
    ).rejects.toMatchObject({ status: 409, code: "UPLOAD_IN_PROGRESS" });

    // Expire attempt 1's lease in DB, then claim attempt 2 -> distinct attemptId and key
    await pg.query(
      `UPDATE documents SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1::uuid`,
      [docId],
    );

    const claim2 = await claimDocumentUploadAttempt(sql, {
      workspaceId,
      documentId: docId,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: bytesV2.byteLength,
      leaseSeconds: 60,
    });
    expect(claim2.attemptId).not.toBe(claim1.attemptId);
    expect(claim2.storageKey).not.toBe(claim1.storageKey);

    // 4b: Stale token (claim1) cannot commit; only current token (claim2) can commit
    await expect(
      commitDocumentUploadAttempt(sql, {
        workspaceId,
        documentId: docId,
        attemptId: claim1.attemptId,
        storageKey: claim1.storageKey,
        bucketName: b2.client.bucketName,
      }),
    ).rejects.toMatchObject({ status: 409, code: "UPLOAD_ATTEMPT_SUPERSEDED" });

    const committed = await commitDocumentUploadAttempt(sql, {
      workspaceId,
      documentId: docId,
      attemptId: claim2.attemptId,
      storageKey: claim2.storageKey,
      bucketName: b2.client.bucketName,
    });
    expect(committed.document.status).toBe("uploaded");
    expect(committed.document.storageKey).toBe(claim2.storageKey);

    // 5: Full HTTP late-attempt race:
    // Start Attempt A in handleUploadDocument -> pause inside B2 putObject -> expire lease ->
    // run Attempt B to completion -> let Attempt A finish late -> verify Attempt A gets 409,
    // canonical key & B2 bytes remain Attempt B's, and Attempt A's orphan key is in outbox!
    const createdRace = await createPersistedBatch([
      { filename: "http-race.pdf", sizeBytes: bytesV1.byteLength },
    ]);
    const raceDocId = createdRace.documents[0]!.id;

    let releaseSlowPut!: () => void;
    let slowPutEntered!: () => void;
    const slowPutStarted = new Promise<void>((r) => {
      slowPutEntered = r;
    });

    let putCallCount = 0;
    let attemptAKey = "";
    let attemptBKey = "";
    b2.putInterceptor = async ({ key }) => {
      putCallCount += 1;
      if (putCallCount === 1) {
        attemptAKey = key;
        slowPutEntered();
        await new Promise<void>((resolve) => {
          releaseSlowPut = resolve;
        });
      } else {
        attemptBKey = key;
      }
    };

    const attemptAPromise = handleUploadDocument(makeUploadRequest(raceDocId, bytesV1), raceDocId, {
      sql,
      b2: b2.client,
      leaseSeconds: 30,
    });
    await slowPutStarted;

    // Expire Attempt A's lease while its B2 upload is still in flight
    await pg.query(
      `UPDATE documents SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1::uuid`,
      [raceDocId],
    );

    const attemptBRes = await handleUploadDocument(
      makeUploadRequest(raceDocId, bytesV2),
      raceDocId,
      { sql, b2: b2.client, leaseSeconds: 30 },
    );
    expect(attemptBRes.status).toBe(200);
    expect(attemptBKey).not.toBe("");
    expect(attemptBKey).not.toBe(attemptAKey);

    // Now let Attempt A wake up and finish streaming to its own key
    releaseSlowPut();
    const attemptARes = await attemptAPromise;
    expect(attemptARes.status).toBe(409);

    // Canonical object & bytes MUST still be Attempt B's; Attempt B's object was NEVER deleted
    const finalRow = await pg.query<{ storage_key: string; status: string }>(
      `SELECT storage_key, status FROM documents WHERE id = $1::uuid`,
      [raceDocId],
    );
    expect(finalRow.rows[0]?.status).toBe("uploaded");
    expect(finalRow.rows[0]?.storage_key).toBe(attemptBKey);
    expect(b2.objects.get(attemptBKey)).toEqual(bytesV2);
    expect(b2.deletedKeys).not.toContain(attemptBKey);

    const outbox = await pg.query<{ storage_key: string; status: string; reason: string }>(
      `SELECT storage_key, status, reason FROM storage_cleanup_outbox WHERE storage_key = $1`,
      [attemptAKey],
    );
    expect(outbox.rows[0]).toEqual({
      storage_key: attemptAKey,
      status: "pending",
      reason: "orphaned_attempt",
    });
  });

  it("6. Propagates client stream cancellation to upstream B2 request and records failure without reporting success", async () => {
    mocks.getSession.mockResolvedValue(USER_A);

    const pdf = makePdfBytes("cancellable");
    const created = await createPersistedBatch([
      { filename: "cancel-me.pdf", sizeBytes: pdf.byteLength },
    ]);
    const docId = created.documents[0]!.id;

    let upstreamSignal: AbortSignal | undefined;
    let putEntered!: () => void;
    const putStarted = new Promise<void>((r) => {
      putEntered = r;
    });

    b2.putInterceptor = async ({ signal }) => {
      upstreamSignal = signal;
      putEntered();
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    };

    const clientAbort = new AbortController();
    const slowStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(pdf.subarray(0, 8));
      },
      pull() {
        return new Promise(() => {
          // keep stream open until aborted
        });
      },
    });

    const uploadPromise = handleUploadDocument(
      makeUploadRequest(docId, slowStream, {
        contentLength: String(pdf.byteLength),
        signal: clientAbort.signal,
      }),
      docId,
      { sql, b2: b2.client },
    );

    await putStarted;
    expect(upstreamSignal?.aborted).toBe(false);

    clientAbort.abort();
    const res = await uploadPromise;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(499);

    const row = await pg.query<{
      status: string;
      storage_key: string | null;
      error_message: string;
    }>(`SELECT status, storage_key, error_message FROM documents WHERE id = $1::uuid`, [docId]);
    expect(row.rows[0]?.status).toBe("failed");
    expect(row.rows[0]?.storage_key).toBeNull();
    expect(row.rows[0]?.error_message).toMatch(/cancelled/i);

    // Explicit POST /api/documents/:id/cancel also works safely and never disturbs uploaded docs
    const cancelRes = await handleCancelDocumentUpload(
      new Request(`https://app.test/api/documents/${docId}/cancel`, {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json" },
        body: "{}",
      }),
      docId,
      { sql, b2: b2.client },
    );
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()).cancelled).toBe(false);
  });

  it("7. Handles B2 failure before and after streaming and records orphans for cleanup", async () => {
    mocks.getSession.mockResolvedValue(USER_A);

    const pdf = makePdfBytes("b2-failures");
    const created = await createPersistedBatch([
      { filename: "pre-fail.pdf", sizeBytes: pdf.byteLength },
      { filename: "post-fail.pdf", sizeBytes: pdf.byteLength },
    ]);
    const [preDoc, postDoc] = created.documents;

    // 7a: B2 fails BEFORE consuming any body bytes
    b2.putInterceptor = async () => {
      throw new B2StorageError(503, "ServiceUnavailable", "ServiceUnavailable", true);
    };
    const preRes = await handleUploadDocument(makeUploadRequest(preDoc!.id, pdf), preDoc!.id, {
      sql,
      b2: b2.client,
    });
    expect(preRes.status).toBe(502);

    const preRow = await pg.query<{ status: string; storage_key: string | null }>(
      `SELECT status, storage_key FROM documents WHERE id = $1::uuid`,
      [preDoc!.id],
    );
    expect(preRow.rows[0]?.status).toBe("failed");
    expect(preRow.rows[0]?.storage_key).toBeNull();
    const preOutbox = await pg.query(
      `SELECT * FROM storage_cleanup_outbox WHERE document_id = $1::uuid`,
      [preDoc!.id],
    );
    expect(preOutbox.rows).toHaveLength(0);

    // 7b: B2 fails AFTER streaming body bytes (e.g., partial write / 500 after upload body read)
    let failedKey = "";
    b2.putInterceptor = async ({ key, body }) => {
      failedKey = key;
      const bytes = await readStreamAll(body);
      b2.objects.set(key, bytes); // simulate B2 having written bytes before returning 500
      throw new B2StorageError(500, "InternalError", "InternalError", true);
    };
    const postRes = await handleUploadDocument(makeUploadRequest(postDoc!.id, pdf), postDoc!.id, {
      sql,
      b2: b2.client,
    });
    expect(postRes.status).toBe(502);

    const postRow = await pg.query<{ status: string; storage_key: string | null }>(
      `SELECT status, storage_key FROM documents WHERE id = $1::uuid`,
      [postDoc!.id],
    );
    expect(postRow.rows[0]?.status).toBe("failed");
    expect(postRow.rows[0]?.storage_key).toBeNull();

    // Orphan object is persisted in storage_cleanup_outbox and recoverable via cleanup
    const postOutbox = await pg.query<{ storage_key: string; status: string; reason: string }>(
      `SELECT storage_key, status, reason FROM storage_cleanup_outbox WHERE document_id = $1::uuid`,
      [postDoc!.id],
    );
    expect(postOutbox.rows).toEqual([
      {
        storage_key: failedKey,
        status: "pending",
        reason: "upload_failed",
      },
    ]);

    // Also verify missing B2 object on GET returns 404 (not empty 200)
    b2.putInterceptor = undefined;
    const retryRes = await handleUploadDocument(makeUploadRequest(postDoc!.id, pdf), postDoc!.id, {
      sql,
      b2: b2.client,
    });
    expect(retryRes.status).toBe(200);
    b2.objects.clear();
    const missingObjRes = await handleGetDocumentContent(
      new Request(`https://app.test/api/documents/${postDoc!.id}/content`),
      postDoc!.id,
      { sql, b2: b2.client },
    );
    expect(missingObjRes.status).toBe(404);
    expect((await missingObjRes.json()).code).toBe("DOCUMENT_CONTENT_MISSING");
  });
});
