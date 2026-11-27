// @vitest-environment node
/**
 * Phase 7 — Review & approval workflow acceptance checks (2–8, 10).
 *
 * Exercises server-owned state transitions, impossible-transition rejection,
 * idempotent duplicate submission, concurrent conflicting update protection,
 * reload persistence, technical upload isolation, cross-workspace & auth/CSRF
 * security, canonical label & read-only export consistency, and compiled Nitro
 * Worker routing against real PGlite migrations.
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

import { persistedDocumentsToCsv } from "@/lib/gathr/export";
import {
  ALLOWED_DOCUMENT_REVIEW_TRANSITIONS,
  DOCUMENT_REVIEW_STATUSES,
  formatReviewStatusLabel,
  type DocumentReviewStatus,
} from "@/lib/gathr/ingestion-types";
import { B2ObjectNotFoundError, type B2StorageClient } from "@/lib/server/b2-storage";
import { reconcileStaleUploadAttempts } from "@/lib/server/lifecycle";
import type { SqlClient } from "@/lib/server/sql";
import { handleGetBatchDetail, handleDeleteBatch } from "@/routes/api.batches.$id";
import { handleFinalizeBatch } from "@/routes/api.batches.$id.finalize";
import { handleGetBatches, handlePostBatches } from "@/routes/api.batches";
import { handleListDocuments } from "@/routes/api.documents";
import { handleCancelDocumentUpload } from "@/routes/api.documents.$id.cancel";
import { handleReviewDocument } from "@/routes/api.documents.$id.review";
import { handleGetDocumentDetail } from "@/routes/api.documents.$id";
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

function createFakeB2(bucketName = "gathr-p7-test"): {
  objects: Map<string, Uint8Array>;
  client: B2StorageClient;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    client: {
      bucketName,
      async putObject({ key, body }) {
        const bytes = await readStreamAll(body);
        objects.set(key, bytes);
        return { etag: `"etag-${bytes.byteLength}"` };
      },
      async getObject({ key }) {
        const bytes = objects.get(key);
        if (!bytes) throw new B2ObjectNotFoundError();
        return {
          body: new ReadableStream({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          }),
          contentLength: bytes.byteLength,
          contentType: "application/pdf",
          etag: `"etag-${bytes.byteLength}"`,
        };
      },
      async deleteObject({ key }) {
        return { deleted: objects.delete(key) };
      },
    },
  };
}

function makePdfBytes(tag: string): Uint8Array {
  return new TextEncoder().encode(
    `%PDF-1.7\n% phase7 ${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`,
  );
}

const USER_A = {
  user: { id: "user-p7-a", name: "Kavya Rao", email: "kavya@example.com", emailVerified: true },
  session: { id: "sess-p7-a", userId: "user-p7-a" },
};

const USER_B = {
  user: { id: "user-p7-b", name: "Rohan Mehta", email: "rohan@example.com", emailVerified: true },
  session: { id: "sess-p7-b", userId: "user-p7-b" },
};

describe("Phase 7 — Review and approval workflow (PGlite + Web HTTP)", () => {
  const originUrl = "https://app.test";
  let pg: PGlite;
  let sql: SqlClient;
  let b2: ReturnType<typeof createFakeB2>;

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
       ('user-p7-a', 'Kavya Rao', 'kavya@example.com'),
       ('user-p7-b', 'Rohan Mehta', 'rohan@example.com')`,
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
      new Request(`${originUrl}/api/batches`, {
        method: "POST",
        headers: { origin: originUrl, "content-type": "application/json" },
        body: JSON.stringify({ name, files }),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as {
      batch: { id: string; name: string; status: string };
      documents: Array<{ id: string; originalFilename: string; fileSizeBytes: number }>;
    };
  }

  async function uploadPdf(documentId: string, bytes: Uint8Array) {
    const res = await handleUploadDocument(
      new Request(`${originUrl}/api/documents/${documentId}/upload`, {
        method: "PUT",
        headers: {
          origin: originUrl,
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

  function reviewReq(
    documentId: string,
    body: unknown,
    options?: { origin?: string; idempotencyKey?: string; method?: string },
  ) {
    const method = options?.method ?? "POST";
    const headers: Record<string, string> = {};
    if (method !== "GET" && method !== "HEAD") {
      headers["content-type"] = "application/json";
    }
    if (options?.origin !== "") {
      headers["origin"] = options?.origin ?? originUrl;
    }
    if (options?.idempotencyKey) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return handleReviewDocument(
      new Request(`${originUrl}/api/documents/${documentId}/review`, init),
      documentId,
      { sql },
    );
  }

  it("2 & 6. Executes canonical review transitions, persists across reload, and allows review on finalized batches", async () => {
    const pdf1 = makePdfBytes("doc-1");
    const pdf2 = makePdfBytes("doc-2");
    const created = await createBatch("Phase 7 Canonical Flow", [
      { filename: "inv-001.pdf", sizeBytes: pdf1.byteLength },
      { filename: "inv-002.pdf", sizeBytes: pdf2.byteLength },
    ]);
    const [d1, d2] = created.documents;

    await uploadPdf(d1!.id, pdf1);
    await uploadPdf(d2!.id, pdf2);

    // Finalize intake — review must still work on uploaded documents
    const finRes = await handleFinalizeBatch(
      new Request(`${originUrl}/api/batches/${created.batch.id}/finalize`, {
        method: "POST",
        headers: { origin: originUrl, "content-type": "application/json" },
        body: "{}",
      }),
      created.batch.id,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(finRes.status).toBe(200);

    // Walk full canonical lifecycle on d1: null -> needs_review -> verified -> needs_review -> rejected -> needs_review -> duplicate -> needs_review -> skipped
    const sequence: DocumentReviewStatus[] = [
      "needs_review",
      "verified",
      "needs_review",
      "rejected",
      "needs_review",
      "duplicate",
      "needs_review",
      "skipped",
    ];
    let expectedVersion = 0;
    let expectedStatus: DocumentReviewStatus | null = null;

    for (const nextStatus of sequence) {
      const res = await reviewReq(
        d1!.id,
        {
          reviewStatus: nextStatus,
          expectedReviewStatus: expectedStatus,
          expectedReviewVersion: expectedVersion,
        },
        { idempotencyKey: `seq-${nextStatus}-${expectedVersion}` },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.idempotentReplay).toBe(false);
      expect(body.document.reviewStatus).toBe(nextStatus);
      expect(body.document.reviewVersion).toBe(expectedVersion + 1);
      expect(body.document.reviewUpdatedAt).toBeTruthy();
      expectedVersion += 1;
      expectedStatus = nextStatus;
    }

    // Direct null -> verified on d2
    const directApprove = await reviewReq(
      d2!.id,
      { reviewStatus: "verified", expectedReviewStatus: null, expectedReviewVersion: 0 },
      { idempotencyKey: "direct-approve-d2" },
    );
    expect(directApprove.status).toBe(200);

    // Reload verification across GET /api/documents/:id, GET /api/batches/:id, GET /api/documents, GET /api/batches
    const docDetail = await (
      await handleGetDocumentDetail(new Request(`${originUrl}/api/documents/${d1!.id}`), d1!.id, {
        sql,
      })
    ).json();
    expect(docDetail.document.reviewStatus).toBe("skipped");
    expect(docDetail.document.reviewVersion).toBe(sequence.length);
    expect(docDetail.reviewEvents).toHaveLength(sequence.length);
    expect(docDetail.reviewEvents[0].actorName).toBe("Kavya Rao");

    const batchDetail = await (
      await handleGetBatchDetail(
        new Request(`${originUrl}/api/batches/${created.batch.id}`),
        created.batch.id,
      )
    ).json();
    expect(batchDetail.documents.map((d: { reviewStatus: string }) => d.reviewStatus)).toEqual([
      "skipped",
      "verified",
    ]);

    const docList = await (
      await handleListDocuments(
        new Request(`${originUrl}/api/documents?batchId=${created.batch.id}`),
        { sql },
      )
    ).json();
    expect(docList.documents).toHaveLength(2);
    expect(docList.counts).toMatchObject({
      verified: 1,
      skipped: 1,
    });
  });

  it("3. Rejects every invalid state transition, non-uploaded document review, bad payload, and unknown status on the server", async () => {
    const pdf = makePdfBytes("invalid-matrix");
    const created = await createBatch("Invalid Transitions", [
      { filename: "pending.pdf", sizeBytes: pdf.byteLength },
      { filename: "failed.pdf", sizeBytes: pdf.byteLength },
      { filename: "uploaded.pdf", sizeBytes: pdf.byteLength },
    ]);
    const [pendingDoc, failedDoc, uploadedDoc] = created.documents;

    // Make failedDoc actually 'failed' via invalid upload
    const badUpload = await handleUploadDocument(
      new Request(`${originUrl}/api/documents/${failedDoc!.id}/upload`, {
        method: "PUT",
        headers: {
          origin: originUrl,
          "content-type": "application/pdf",
          "content-length": String(pdf.byteLength),
        },
        body: new Uint8Array(pdf.byteLength).fill(0x41),
      }),
      failedDoc!.id,
      { sql, b2: b2.client },
    );
    expect(badUpload.status).toBe(400);

    // Non-uploaded documents must reject EVERY review status
    for (const nonUploadedId of [pendingDoc!.id, failedDoc!.id]) {
      for (const st of DOCUMENT_REVIEW_STATUSES) {
        const res = await reviewReq(nonUploadedId, { reviewStatus: st });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe("DOCUMENT_NOT_UPLOADED");
      }
    }

    await uploadPdf(uploadedDoc!.id, pdf);

    // Invalid review values & unexpected fields
    for (const badBody of [
      { reviewStatus: null },
      { reviewStatus: "" },
      { reviewStatus: "approved" },
      { reviewStatus: "deleted" },
      { reviewStatus: "verified", role: "admin" },
      { reviewStatus: "verified", workspaceId: "11111111-1111-4111-8111-111111111111" },
      "not-json",
    ]) {
      const res = await reviewReq(uploadedDoc!.id, badBody);
      expect(res.status).toBe(400);
    }

    // Exhaustively test every disallowed cross-decision transition
    const decidedStates: DocumentReviewStatus[] = ["verified", "duplicate", "rejected", "skipped"];
    for (const fromState of decidedStates) {
      // Transition via needs_review (or directly from null on first iteration)
      if (fromState !== "verified") {
        expect((await reviewReq(uploadedDoc!.id, { reviewStatus: "needs_review" })).status).toBe(
          200,
        );
      }
      expect((await reviewReq(uploadedDoc!.id, { reviewStatus: fromState })).status).toBe(200);

      for (const target of DOCUMENT_REVIEW_STATUSES) {
        if (target === fromState) continue;
        const allowed = ALLOWED_DOCUMENT_REVIEW_TRANSITIONS[fromState].includes(target);
        if (!allowed) {
          const rej = await reviewReq(uploadedDoc!.id, { reviewStatus: target });
          expect(rej.status).toBe(409);
          const errBody = await rej.json();
          expect(errBody.code).toBe("INVALID_REVIEW_TRANSITION");
          expect(errBody.currentDocument.reviewStatus).toBe(fromState);
        }
      }
    }
  });

  it("4. Handles duplicate submissions idempotently without duplicating history or bumping review_version", async () => {
    const pdf = makePdfBytes("idempotent");
    const created = await createBatch("Idempotency Batch", [
      { filename: "idem.pdf", sizeBytes: pdf.byteLength },
    ]);
    const docId = created.documents[0]!.id;
    await uploadPdf(docId, pdf);

    // Concurrent identical requests sharing one Idempotency-Key
    const [r1, r2] = await Promise.all([
      reviewReq(
        docId,
        { reviewStatus: "verified", expectedReviewStatus: null, expectedReviewVersion: 0 },
        { idempotencyKey: "same-click-key" },
      ),
      reviewReq(
        docId,
        { reviewStatus: "verified", expectedReviewStatus: null, expectedReviewVersion: 0 },
        { idempotencyKey: "same-click-key" },
      ),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2Body = await r2.json();
    expect(b1.document.reviewVersion).toBe(1);
    expect(b2Body.document.reviewVersion).toBe(1);

    // Network retry carrying original stale expectedReviewVersion: 0 with same Idempotency-Key replays cleanly
    const retryRes = await reviewReq(
      docId,
      { reviewStatus: "verified", expectedReviewStatus: null, expectedReviewVersion: 0 },
      { idempotencyKey: "same-click-key" },
    );
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.idempotentReplay).toBe(true);
    expect(retryBody.document.reviewVersion).toBe(1);

    // Sequential identical decision without stale expectation returns alreadyInState without extra event
    const repeatRes = await reviewReq(
      docId,
      { reviewStatus: "verified" },
      { idempotencyKey: "second-click-key" },
    );
    expect(repeatRes.status).toBe(200);
    const repeatBody = await repeatRes.json();
    expect(repeatBody.alreadyInState).toBe(true);
    expect(repeatBody.document.reviewVersion).toBe(1);

    // Reusing an Idempotency-Key for a different decision rejects with 409 IDEMPOTENCY_CONFLICT
    const mismatchKey = await reviewReq(
      docId,
      { reviewStatus: "needs_review" },
      { idempotencyKey: "same-click-key" },
    );
    expect(mismatchKey.status).toBe(409);
    expect((await mismatchKey.json()).code).toBe("IDEMPOTENCY_CONFLICT");

    const eventCount = await pg.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM document_review_events WHERE document_id = $1::uuid`,
      [docId],
    );
    expect(eventCount.rows[0]?.c).toBe(1);
  });

  it("5. Enforces concurrency control on conflicting updates (optimistic conflict & lock-serialized transitions)", async () => {
    const pdf = makePdfBytes("concurrency");
    const created = await createBatch("Concurrency Batch", [
      { filename: "race-optimistic.pdf", sizeBytes: pdf.byteLength },
      { filename: "race-nolock-hint.pdf", sizeBytes: pdf.byteLength },
    ]);
    const [d1, d2] = created.documents;
    await uploadPdf(d1!.id, pdf);
    await uploadPdf(d2!.id, pdf);

    // 5a: Two tabs read v0 and concurrently submit Approve vs Reject -> one 200, one 409 REVIEW_STATE_CONFLICT
    const [resA, resB] = await Promise.all([
      reviewReq(
        d1!.id,
        { reviewStatus: "verified", expectedReviewStatus: null, expectedReviewVersion: 0 },
        { idempotencyKey: "tab-a-approve" },
      ),
      reviewReq(
        d1!.id,
        { reviewStatus: "rejected", expectedReviewStatus: null, expectedReviewVersion: 0 },
        { idempotencyKey: "tab-b-reject" },
      ),
    ]);
    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    const winnerBody = resA.status === 200 ? await resA.json() : await resB.json();
    const loserBody = resA.status === 409 ? await resA.json() : await resB.json();
    expect(loserBody.code).toBe("REVIEW_STATE_CONFLICT");
    expect(loserBody.currentDocument.reviewStatus).toBe(winnerBody.document.reviewStatus);
    expect(loserBody.currentDocument.reviewVersion).toBe(1);

    // 5b: Even without expectedReviewVersion, concurrent Approve vs Reject cannot overwrite each other
    const [resC, resD] = await Promise.all([
      reviewReq(d2!.id, { reviewStatus: "verified" }, { idempotencyKey: "nolock-approve" }),
      reviewReq(d2!.id, { reviewStatus: "rejected" }, { idempotencyKey: "nolock-reject" }),
    ]);
    expect([resC.status, resD.status].sort()).toEqual([200, 409]);
    const evD2 = await pg.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM document_review_events WHERE document_id = $1::uuid`,
      [d2!.id],
    );
    expect(evD2.rows[0]?.c).toBe(1);
  });

  it("7. Ensures upload success, upload failure, cancel, lease expiry, and batch deletion never fabricate review decisions", async () => {
    const pdf = makePdfBytes("isolation");
    const created = await createBatch("Isolation Batch", [
      { filename: "uploaded-stays-null.pdf", sizeBytes: pdf.byteLength },
      { filename: "cancelled-stays-null.pdf", sizeBytes: pdf.byteLength },
      { filename: "expired-stays-null.pdf", sizeBytes: pdf.byteLength },
    ]);
    const [d1, d2, d3] = created.documents;

    const up = await uploadPdf(d1!.id, pdf);
    expect(up.document.status).toBe("uploaded");
    expect(up.document.reviewStatus).toBeNull();

    // Failed invalid-PDF upload and cancelled upload keep review_status = NULL
    const invalidBytes = new TextEncoder().encode("NOT-A-PDF");
    const badRes = await handleUploadDocument(
      new Request(`${originUrl}/api/documents/${d2!.id}/upload`, {
        method: "PUT",
        headers: {
          origin: originUrl,
          "content-type": "application/pdf",
          "content-length": String(invalidBytes.byteLength),
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(invalidBytes);
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      d2!.id,
      { sql, b2: b2.client },
    );
    expect(badRes.status).toBe(400);

    await handleCancelDocumentUpload(
      new Request(`${originUrl}/api/documents/${d2!.id}/cancel`, {
        method: "POST",
        headers: { origin: originUrl, "content-type": "application/json" },
        body: "{}",
      }),
      d2!.id,
      { sql, b2: b2.client },
    );

    // Claim d3 into uploading, expire its lease, and reconcile -> transitions to failed with review_status = NULL
    await pg.query(
      `UPDATE documents
       SET status = 'uploading',
           active_attempt_id = gen_random_uuid(),
           lease_expires_at = NOW() - INTERVAL '1 hour'
       WHERE id = $1::uuid`,
      [d3!.id],
    );
    const reconciled = await reconcileStaleUploadAttempts(sql, {
      bucketName: b2.client.bucketName,
    });
    expect(reconciled.reconciled).toBeGreaterThanOrEqual(1);

    const rows = await pg.query<{ status: string; review_status: string | null }>(
      `SELECT status, review_status FROM documents WHERE batch_id = $1::uuid ORDER BY created_at`,
      [created.batch.id],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["uploaded", "pending_upload", "failed"]);
    expect(rows.rows.every((r) => r.review_status === null)).toBe(true);

    // Deleting batch cleans up cleanly without creating any review event
    const delRes = await handleDeleteBatch(
      new Request(`${originUrl}/api/batches/${created.batch.id}`, {
        method: "DELETE",
        headers: { origin: originUrl },
      }),
      created.batch.id,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(delRes.status).toBe(200);
  });

  it("8. Blocks unauthenticated, cross-origin, workspace-spoofed, wrong-method, and cross-workspace review access", async () => {
    const pdf = makePdfBytes("security");
    const createdA = await createBatch("Tenant A Review", [
      { filename: "secret-a.pdf", sizeBytes: pdf.byteLength },
    ]);
    const docAId = createdA.documents[0]!.id;
    await uploadPdf(docAId, pdf);

    // Cross-workspace attempts by User B
    mocks.getSession.mockResolvedValue(USER_B);
    const missingId = "99999999-9999-4999-8999-999999999999";
    const crossReview = await reviewReq(docAId, { reviewStatus: "verified" });
    const missingReview = await reviewReq(missingId, { reviewStatus: "verified" });
    expect(crossReview.status).toBe(404);
    expect(missingReview.status).toBe(404);
    expect(await crossReview.text()).toBe(await missingReview.text());

    // Tenant B's GET /api/documents never includes Tenant A's document
    const listB = await (
      await handleListDocuments(new Request(`${originUrl}/api/documents`), { sql })
    ).json();
    expect(listB.documents).toEqual([]);
    expect(listB.counts.total).toBe(0);

    // Cross-origin, wrong method, client workspaceId, unauthenticated
    mocks.getSession.mockResolvedValue(USER_A);
    expect(
      (await reviewReq(docAId, { reviewStatus: "verified" }, { origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect((await reviewReq(docAId, { reviewStatus: "verified" }, { origin: "" })).status).toBe(
      403,
    );
    const wrongMethod = await reviewReq(docAId, { reviewStatus: "verified" }, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const spoofWs = await handleListDocuments(
      new Request(`${originUrl}/api/documents?workspaceId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`),
      { sql },
    );
    expect(spoofWs.status).toBe(400);

    mocks.getSession.mockResolvedValue(null);
    expect((await reviewReq(docAId, { reviewStatus: "verified" })).status).toBe(401);
    expect(
      (await handleListDocuments(new Request(`${originUrl}/api/documents`), { sql })).status,
    ).toBe(401);
  });

  it("10. Matches persisted review status labels across list, detail, and read-only CSV export without mutation", async () => {
    const pdf = makePdfBytes("export-consistency");
    const created = await createBatch("Export Consistency", [
      { filename: "=cmd|' calc'!A0.pdf", sizeBytes: pdf.byteLength },
      { filename: "verified-doc.pdf", sizeBytes: pdf.byteLength },
      { filename: "rejected-doc.pdf", sizeBytes: pdf.byteLength },
    ]);
    for (const doc of created.documents) {
      await uploadPdf(doc.id, pdf);
    }

    await reviewReq(created.documents[1]!.id, { reviewStatus: "verified" });
    await reviewReq(created.documents[2]!.id, { reviewStatus: "rejected" });

    const listBody = await (
      await handleListDocuments(
        new Request(`${originUrl}/api/documents?batchId=${created.batch.id}`),
        { sql },
      )
    ).json();

    const csv = persistedDocumentsToCsv(listBody.documents);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain(formatReviewStatusLabel(null)); // Unreviewed
    expect(csv).toContain(formatReviewStatusLabel("verified")); // Verified
    expect(csv).toContain(formatReviewStatusLabel("rejected")); // Rejected
    expect(csv).toContain("'=cmd_"); // Formula injection neutralized

    // Export must remain strictly read-only
    const afterList = await (
      await handleListDocuments(
        new Request(`${originUrl}/api/documents?batchId=${created.batch.id}`),
        { sql },
      )
    ).json();
    expect(
      afterList.documents.map((d: { reviewStatus: string | null; reviewVersion: number }) => [
        d.reviewStatus,
        d.reviewVersion,
      ]),
    ).toEqual(
      listBody.documents.map((d: { reviewStatus: string | null; reviewVersion: number }) => [
        d.reviewStatus,
        d.reviewVersion,
      ]),
    );
  });

  it("Worker smoke: compiled Nitro bundle dispatches /api/documents and /api/documents/:id/review", async () => {
    if (!existsSync(BUILT_WORKER_PATH)) return;
    const prevDbUrl = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      const workerModule = (await import(pathToFileURL(BUILT_WORKER_PATH).href)) as {
        default?: {
          fetch?: (
            req: Request,
            env: Record<string, unknown>,
            ctx: { waitUntil: (p: Promise<unknown>) => void; passThroughOnException: () => void },
          ) => Promise<Response>;
        };
      };
      const workerFetch = workerModule.default?.fetch;
      expect(typeof workerFetch).toBe("function");
      const dummyCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

      const listPost = await workerFetch!(
        new Request("https://app.test/api/documents", { method: "POST" }),
        {},
        dummyCtx,
      );
      expect(listPost.status).toBe(405);
      expect(listPost.headers.get("allow")).toBe("GET");

      const listUnauth = await workerFetch!(
        new Request("https://app.test/api/documents"),
        {},
        dummyCtx,
      );
      expect([401, 500, 503]).toContain(listUnauth.status);
      expect(listUnauth.status).not.toBe(404);

      const docUuid = "22222222-2222-4222-8222-222222222222";
      const reviewGet = await workerFetch!(
        new Request(`https://app.test/api/documents/${docUuid}/review`, { method: "GET" }),
        {},
        dummyCtx,
      );
      expect(reviewGet.status).toBe(405);
      expect(reviewGet.headers.get("allow")).toBe("POST");

      const reviewCrossOrigin = await workerFetch!(
        new Request(`https://app.test/api/documents/${docUuid}/review`, {
          method: "POST",
          headers: { origin: "https://evil.test", "content-type": "application/json" },
          body: JSON.stringify({ reviewStatus: "verified" }),
        }),
        {},
        dummyCtx,
      );
      expect(reviewCrossOrigin.status).toBe(403);
    } finally {
      if (prevDbUrl !== undefined) {
        process.env["DATABASE_URL"] = prevDbUrl;
      }
    }
  }, 30_000);
});
