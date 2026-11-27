// @vitest-environment node
/**
 * Phase 7 — Rigorous end-to-end smoke & edge-case suite:
 * 1. HTTP transport, Content-Type, chunked 16KiB payload limit, Idempotency-Key & int4 pagination bounds
 * 2. Exhaustive server state machine validation across every decided status, reopen path & idempotent repeat
 * 3. SQL wildcard escaping, BiDi/control char stripping, Unicode filenames, formula injection & CSV fidelity
 * 4. High-contention concurrency: competing decisions, 5x same-key retry burst, review vs delete races
 * 5. Multi-tenant 404 symmetry, zero secret/uncaptured-field leakage, and compiled Nitro Worker bundle smoke
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
  DOCUMENT_REVIEW_STATUSES,
  formatReviewStatusLabel,
  type DocumentReviewStatus,
} from "@/lib/gathr/ingestion-types";
import { B2ObjectNotFoundError, type B2StorageClient } from "@/lib/server/b2-storage";
import { claimDocumentUploadAttempt } from "@/lib/server/documents";
import type { SqlClient } from "@/lib/server/sql";
import { handleDeleteBatch } from "@/routes/api.batches.$id";
import { handleFinalizeBatch } from "@/routes/api.batches.$id.finalize";
import { handlePostBatches } from "@/routes/api.batches";
import { handleDeleteDocument, handleGetDocumentDetail } from "@/routes/api.documents.$id";
import { handleReviewDocument } from "@/routes/api.documents.$id.review";
import { handleUploadDocument } from "@/routes/api.documents.$id.upload";
import { handleListDocuments } from "@/routes/api.documents";

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

function makeFakeB2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const client: B2StorageClient = {
    bucketName: "smoke-test-bucket",
    async putObject({ key, body, contentType }) {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      objects.set(key, { bytes: merged, contentType: contentType ?? "application/pdf" });
      return { etag: `"etag-${merged.byteLength}"` };
    },
    async getObject({ key }) {
      const entry = objects.get(key);
      if (!entry) throw new B2ObjectNotFoundError();
      return {
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(entry.bytes);
            c.close();
          },
        }),
        contentLength: entry.bytes.byteLength,
        contentType: entry.contentType,
        etag: `"etag-${entry.bytes.byteLength}"`,
      };
    },
    async deleteObject({ key }) {
      return { deleted: objects.delete(key) };
    },
  };
  return { objects, client };
}

function makePdf(tag: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n%Smoke(${tag})\n1 0 obj <<>> endobj\n%%EOF`);
}

describe("Phase 7 — Rigorous end-to-end smoke & edge cases", () => {
  let pg: PGlite;
  let sql: SqlClient;
  let b2: ReturnType<typeof makeFakeB2>;
  const originUrl = "http://localhost:3000";

  const USER_A = {
    user: { id: "p7-smoke-a", name: "Asha Iyer", email: "asha@test.local", emailVerified: true },
    session: { id: "sess-smoke-a", userId: "p7-smoke-a" },
  };
  const USER_BLANK = {
    user: { id: "p7-smoke-blank", name: "   ", email: "blank@test.local", emailVerified: true },
    session: { id: "sess-smoke-blank", userId: "p7-smoke-blank" },
  };
  const USER_B = {
    user: { id: "p7-smoke-b", name: "Dev Bose", email: "dev@test.local", emailVerified: true },
    session: { id: "sess-smoke-b", userId: "p7-smoke-b" },
  };

  beforeAll(async () => {
    pg = new PGlite();
    const res = await runMigrations({
      db: pgliteMigrationAdapter(pg),
      dir: MIGRATIONS_DIR,
      mode: "apply",
    });
    expect(res.ok).toBe(true);
    await pg.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)`,
      [
        USER_A.user.id,
        USER_A.user.name,
        USER_A.user.email,
        USER_BLANK.user.id,
        USER_BLANK.user.name,
        USER_BLANK.user.email,
        USER_B.user.id,
        USER_B.user.name,
        USER_B.user.email,
      ],
    );
    sql = makePgSqlClient(pg);
  }, 90_000);

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(() => {
    b2 = makeFakeB2();
    mocks.getSession.mockReset();
    mocks.getSession.mockResolvedValue(USER_A);
    mocks.getSql.mockReset();
    mocks.getSql.mockReturnValue(sql);
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
      batch: { id: string; name: string };
      documents: Array<{ id: string; originalFilename: string; fileSizeBytes: number }>;
    };
  }

  async function uploadPdf(docId: string, bytes: Uint8Array) {
    const res = await handleUploadDocument(
      new Request(`${originUrl}/api/documents/${docId}/upload`, {
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
      docId,
      { sql, b2: b2.client },
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  function reviewPost(docId: string, body: unknown, headers: Record<string, string> = {}) {
    return handleReviewDocument(
      new Request(`${originUrl}/api/documents/${docId}/review`, {
        method: "POST",
        headers: { origin: originUrl, "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      docId,
      { sql },
    );
  }

  it("1. Rejects bad methods, wrong Content-Types, chunked >16KiB payloads, invalid Idempotency-Keys, padded UUIDs & int4 pagination overflow cleanly without 500s", async () => {
    const pdf = makePdf("http-guards");
    const created = await createBatch("HTTP Guardrails", [
      { filename: "guards.pdf", sizeBytes: pdf.byteLength },
    ]);
    const docId = created.documents[0]!.id;
    await uploadPdf(docId, pdf);

    // Wrong HTTP methods on both routes
    for (const method of ["PUT", "PATCH", "DELETE", "GET"]) {
      const r = await handleReviewDocument(
        new Request(`${originUrl}/api/documents/${docId}/review`, { method }),
        docId,
        { sql },
      );
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await handleListDocuments(new Request(`${originUrl}/api/documents`, { method }), {
        sql,
      });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET");
    }

    // Wrong Content-Type
    const plainRes = await handleReviewDocument(
      new Request(`${originUrl}/api/documents/${docId}/review`, {
        method: "POST",
        headers: { origin: originUrl, "content-type": "text/plain" },
        body: JSON.stringify({ reviewStatus: "verified" }),
      }),
      docId,
      { sql },
    );
    expect(plainRes.status).toBe(415);

    // Empty body, malformed JSON, array, primitive, extra field, client workspaceId
    expect((await reviewPost(docId, "")).status).toBe(400);
    expect((await reviewPost(docId, "{bad")).status).toBe(400);
    expect((await reviewPost(docId, [])).status).toBe(400);
    expect(
      (await reviewPost(docId, { reviewStatus: "verified", workspaceId: "ws-x" })).status,
    ).toBe(400);
    expect((await reviewPost(docId, { reviewStatus: "verified", extra: true })).status).toBe(400);

    // Lying small Content-Length with >16 KiB chunked JSON stream -> 413 PAYLOAD_TOO_LARGE
    const largeChunk = new TextEncoder().encode(
      JSON.stringify({ reviewStatus: "verified", pad: "a".repeat(20 * 1024) }),
    );
    const chunkedOversized = await handleReviewDocument(
      new Request(`${originUrl}/api/documents/${docId}/review`, {
        method: "POST",
        headers: {
          origin: originUrl,
          "content-type": "application/json",
          "content-length": "50",
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(largeChunk);
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      docId,
      { sql },
    );
    expect(chunkedOversized.status).toBe(413);

    // Invalid Idempotency-Key headers must return 400 (never 500)
    for (const badKey of ["", "   ", "bad key with spaces!", "k".repeat(129)]) {
      const kRes = await reviewPost(
        docId,
        { reviewStatus: "verified" },
        { "idempotency-key": badKey },
      );
      expect(kRes.status).toBe(400);
      expect(((await kRes.json()) as { code?: string }).code).toBe("INVALID_IDEMPOTENCY_KEY");
    }

    // Invalid UUIDs & whitespace-padded UUIDs -> 400 without hitting SQL 22P02
    expect((await reviewPost(` ${docId}`, { reviewStatus: "verified" })).status).toBe(400);
    expect((await reviewPost("not-a-uuid", { reviewStatus: "verified" })).status).toBe(400);

    // Query validation including int4 overflow offset (> 2_147_483_647)
    for (const qs of [
      "status=unknown",
      "reviewStatus=null",
      "reviewStatus=approved",
      "batchId=bad-uuid",
      "limit=0",
      "limit=201",
      "offset=-1",
      "offset=3000000000",
      "workspaceId=11111111-1111-4111-8111-111111111111",
    ]) {
      const res = await handleListDocuments(new Request(`${originUrl}/api/documents?${qs}`), {
        sql,
      });
      expect(res.status).toBe(400);
    }
  });

  it("2. Exhaustively checks decided state transitions, stale same-state conflicts, idempotency hash mismatches, and non-uploaded blockers", async () => {
    const pdf = makePdf("matrix");
    const created = await createBatch("State Matrix Batch", [
      { filename: "matrix.pdf", sizeBytes: pdf.byteLength },
      { filename: "active-lease.pdf", sizeBytes: pdf.byteLength },
    ]);
    const docId = created.documents[0]!.id;
    const uploadingDocId = created.documents[1]!.id;
    await uploadPdf(docId, pdf);

    // Claim uploadingDocId into 'uploading' (active lease) -> review must reject with 409 DOCUMENT_NOT_UPLOADED
    const wsRow = await pg.query<{ workspace_id: string }>(
      `SELECT workspace_id::text FROM batches WHERE id = $1::uuid`,
      [created.batch.id],
    );
    const claim = await claimDocumentUploadAttempt(sql, {
      workspaceId: wsRow.rows[0]!.workspace_id,
      documentId: uploadingDocId,
      declaredSizeBytes: pdf.byteLength,
      bucketName: b2.client.bucketName,
    });
    expect(claim.attemptId).toBeTruthy();
    const whileUploading = await reviewPost(uploadingDocId, { reviewStatus: "verified" });
    expect(whileUploading.status).toBe(409);
    expect(((await whileUploading.json()) as { code: string }).code).toBe("DOCUMENT_NOT_UPLOADED");

    // Exhaustively test every decided status -> every OTHER decided status fails, only 'needs_review' reopens
    const outcomes: DocumentReviewStatus[] = ["verified", "duplicate", "rejected", "skipped"];
    let version = 0;
    let currentStatus: DocumentReviewStatus | null = null;

    for (const chosen of outcomes) {
      const okRes = await reviewPost(
        docId,
        {
          reviewStatus: chosen,
          expectedReviewStatus: currentStatus,
          expectedReviewVersion: version,
        },
        { "idempotency-key": `key-${chosen}-${version}` },
      );
      expect(okRes.status).toBe(200);
      version += 1;
      currentStatus = chosen;

      // Idempotent replay with same key -> 200
      const replay = await reviewPost(
        docId,
        {
          reviewStatus: chosen,
          expectedReviewStatus: chosen === "verified" ? null : "needs_review",
          expectedReviewVersion: version - 1,
        },
        { "idempotency-key": `key-${chosen}-${version - 1}` },
      );
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(true);

      // Reusing same key with DIFFERENT payload -> 409 IDEMPOTENCY_CONFLICT
      const mismatchKey = await reviewPost(
        docId,
        {
          reviewStatus: chosen === "verified" ? "rejected" : "verified",
          expectedReviewVersion: version - 1,
        },
        { "idempotency-key": `key-${chosen}-${version - 1}` },
      );
      expect(mismatchKey.status).toBe(409);

      // Direct jump to any OTHER decided outcome -> 409 INVALID_REVIEW_TRANSITION
      for (const forbidden of outcomes) {
        if (forbidden === chosen) continue;
        const badJump = await reviewPost(docId, {
          reviewStatus: forbidden,
          expectedReviewStatus: chosen,
          expectedReviewVersion: version,
        });
        expect(badJump.status).toBe(409);
        const body = (await badJump.json()) as {
          code: string;
          currentDocument: { reviewVersion: number };
        };
        expect(body.code).toBe("INVALID_REVIEW_TRANSITION");
        expect(body.currentDocument.reviewVersion).toBe(version);
      }

      // Same-state repeat WITH wrong expectedReviewVersion -> 409 REVIEW_STATE_CONFLICT
      const staleSameState = await reviewPost(docId, {
        reviewStatus: chosen,
        expectedReviewVersion: version + 5,
      });
      expect(staleSameState.status).toBe(409);

      // Reopen to needs_review before next iteration
      const reopen = await reviewPost(docId, {
        reviewStatus: "needs_review",
        expectedReviewStatus: chosen,
        expectedReviewVersion: version,
      });
      expect(reopen.status).toBe(200);
      version += 1;
      currentStatus = "needs_review";
    }

    // Blank actor name falls back to "Workspace owner"
    mocks.getSession.mockResolvedValue(USER_BLANK);
    const blankBatch = await createBatch("Blank Actor Batch", [
      { filename: "blank-actor.pdf", sizeBytes: pdf.byteLength },
    ]);
    const blankDocId = blankBatch.documents[0]!.id;
    await uploadPdf(blankDocId, pdf);
    const blankReview = await (await reviewPost(blankDocId, { reviewStatus: "verified" })).json();
    expect(blankReview.reviewEvents[0].actorName).toBe("Workspace owner");
  });

  it("3. Escapes SQL wildcards (%, _, \\), preserves Unicode, excludes unuploaded docs from unreviewed filter, and neutralizes CSV injection", async () => {
    const pdf = makePdf("filter-export");
    const created = await createBatch("Special Query_%\\Batch", [
      { filename: "100%_exact_doc.pdf", sizeBytes: pdf.byteLength },
      { filename: "चालान-2026-₹500.pdf", sizeBytes: pdf.byteLength },
      { filename: "=SUM(1,2).pdf", sizeBytes: pdf.byteLength },
      { filename: "+evil.pdf", sizeBytes: pdf.byteLength },
      { filename: "-1+1.pdf", sizeBytes: pdf.byteLength },
      { filename: "still-pending.pdf", sizeBytes: pdf.byteLength },
    ]);
    for (let i = 0; i < 5; i++) {
      await uploadPdf(created.documents[i]!.id, pdf);
    }

    await reviewPost(created.documents[1]!.id, { reviewStatus: "verified" });
    await reviewPost(created.documents[2]!.id, { reviewStatus: "rejected" });

    // Search with % and _ must match ONLY "100%_exact_doc.pdf", NOT every file, and \ searches batch name safely
    const pctSearch = await (
      await handleListDocuments(
        new Request(
          `${originUrl}/api/documents?batchId=${created.batch.id}&q=${encodeURIComponent("%_exact_")}`,
        ),
        { sql },
      )
    ).json();
    expect(
      pctSearch.documents.map((d: { originalFilename: string }) => d.originalFilename),
    ).toEqual(["100%_exact_doc.pdf"]);

    const backslashSearch = await (
      await handleListDocuments(
        new Request(
          `${originUrl}/api/documents?batchId=${created.batch.id}&q=${encodeURIComponent("\\Batch")}`,
        ),
        { sql },
      )
    ).json();
    expect(backslashSearch.documents).toHaveLength(6);

    // ?reviewStatus=unreviewed excludes pending_upload doc
    const unrevRes = await (
      await handleListDocuments(
        new Request(
          `${originUrl}/api/documents?batchId=${created.batch.id}&reviewStatus=unreviewed`,
        ),
        { sql },
      )
    ).json();
    const unrevNames = unrevRes.documents.map(
      (d: { originalFilename: string }) => d.originalFilename,
    );
    expect(unrevNames).not.toContain("still-pending.pdf");
    expect(unrevNames).not.toContain("चालान-2026-₹500.pdf");

    // Pagination slice (limit=2, offset=2) + filteredTotal / hasMore metadata
    const paged = await (
      await handleListDocuments(
        new Request(`${originUrl}/api/documents?batchId=${created.batch.id}&limit=2&offset=2`),
        { sql },
      )
    ).json();
    expect(paged.documents).toHaveLength(2);
    expect(paged.filteredTotal).toBe(6);
    expect(paged.hasMore).toBe(true);

    const lastPage = await (
      await handleListDocuments(
        new Request(`${originUrl}/api/documents?batchId=${created.batch.id}&limit=2&offset=4`),
        { sql },
      )
    ).json();
    expect(lastPage.documents).toHaveLength(2);
    expect(lastPage.filteredTotal).toBe(6);
    expect(lastPage.hasMore).toBe(false);

    // Export consistency across uploaded + pending docs & formula injection defense
    const allRes = await (
      await handleListDocuments(
        new Request(`${originUrl}/api/documents?batchId=${created.batch.id}`),
        { sql },
      )
    ).json();
    expect(allRes.filteredTotal).toBe(6);
    expect(allRes.hasMore).toBe(false);
    const csv = persistedDocumentsToCsv(allRes.documents);
    expect(csv).toContain("चालान-2026-₹500.pdf");
    expect(csv).toContain(formatReviewStatusLabel("verified"));
    expect(csv).toContain(formatReviewStatusLabel("rejected"));
    expect(csv).toContain(",Pending upload,Not uploaded,");
    expect(csv).toContain("'=SUM(1,2).pdf");
    expect(csv).toContain("'+evil.pdf");
    expect(csv).toContain("'-1+1.pdf");

    // DB filenames remain uncorrupted
    expect(
      allRes.documents.some(
        (d: { originalFilename: string }) => d.originalFilename === "=SUM(1,2).pdf",
      ),
    ).toBe(true);
  });

  it("4. Serializes high-contention review races, 5x parallel idempotent retry bursts, finalized batch reviews, and review-vs-delete cleanly", async () => {
    const pdf = makePdf("race-stress");
    const created = await createBatch("Concurrency Batch", [
      { filename: "race-conflict.pdf", sizeBytes: pdf.byteLength },
      { filename: "race-burst.pdf", sizeBytes: pdf.byteLength },
      { filename: "race-delete-doc.pdf", sizeBytes: pdf.byteLength },
    ]);
    const [dConflict, dBurst, dDelete] = created.documents;
    await uploadPdf(dConflict!.id, pdf);
    await uploadPdf(dBurst!.id, pdf);
    await uploadPdf(dDelete!.id, pdf);

    // Race A: two reviewers submit different decisions simultaneously from (null, v0)
    const [r1, r2] = await Promise.all([
      reviewPost(dConflict!.id, {
        reviewStatus: "verified",
        expectedReviewStatus: null,
        expectedReviewVersion: 0,
      }),
      reviewPost(dConflict!.id, {
        reviewStatus: "rejected",
        expectedReviewStatus: null,
        expectedReviewVersion: 0,
      }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const eventsAfterConflict = await pg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM document_review_events WHERE document_id = $1::uuid`,
      [dConflict!.id],
    );
    expect(eventsAfterConflict.rows[0]?.c).toBe(1);

    // Race B: 5 simultaneous retries with identical Idempotency-Key -> zero DB constraint errors, strictly 1 event
    const burstResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        reviewPost(
          dBurst!.id,
          { reviewStatus: "duplicate", expectedReviewStatus: null, expectedReviewVersion: 0 },
          { "idempotency-key": "burst-idem-key-1" },
        ),
      ),
    );
    expect(burstResults.every((r) => r.status === 200)).toBe(true);
    const eventsAfterBurst = await pg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM document_review_events WHERE document_id = $1::uuid`,
      [dBurst!.id],
    );
    expect(eventsAfterBurst.rows[0]?.c).toBe(1);

    // Race C: review vs single-doc deletion -> 200 or 404 without 500/deadlock, events cleanly gone if deleted
    const [revDelRes, delDocRes] = await Promise.all([
      reviewPost(dDelete!.id, { reviewStatus: "skipped" }),
      handleDeleteDocument(
        new Request(`${originUrl}/api/documents/${dDelete!.id}`, {
          method: "DELETE",
          headers: { origin: originUrl },
        }),
        dDelete!.id,
        { sql, bucketName: b2.client.bucketName },
      ),
    ]);
    expect([200, 404]).toContain(revDelRes.status);
    expect(delDocRes.status).toBe(200);
    const orphanEvents = await pg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM document_review_events WHERE document_id = $1::uuid`,
      [dDelete!.id],
    );
    expect(orphanEvents.rows[0]?.c).toBe(0);

    // Finalizing batch allows subsequent human review while batch delete still cleans up cleanly
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

    const reopenAfterFinalize = await reviewPost(dBurst!.id, { reviewStatus: "needs_review" });
    expect(reopenAfterFinalize.status).toBe(200);

    // Concurrent review vs full batch deletion
    const [revBatchDelRes, delBatchRes] = await Promise.all([
      reviewPost(dBurst!.id, { reviewStatus: "verified" }),
      handleDeleteBatch(
        new Request(`${originUrl}/api/batches/${created.batch.id}`, {
          method: "DELETE",
          headers: { origin: originUrl },
        }),
        created.batch.id,
        { sql, bucketName: b2.client.bucketName },
      ),
    ]);
    expect([200, 404]).toContain(revBatchDelRes.status);
    expect(delBatchRes.status).toBe(200);
  });

  it("5. Guarantees non-leakage of storage/invoice fields, tenant 404 symmetry, and compiled Nitro Worker route dispatch", async () => {
    const pdf = makePdf("leak-check");
    const created = await createBatch("Leak Check Batch", [
      { filename: "private-doc.pdf", sizeBytes: pdf.byteLength },
    ]);
    const docId = created.documents[0]!.id;
    await uploadPdf(docId, pdf);

    const revJson = await (await reviewPost(docId, { reviewStatus: "verified" })).text();
    const listJson = await (
      await handleListDocuments(new Request(`${originUrl}/api/documents`), { sql })
    ).text();
    const detailJson = await (
      await handleGetDocumentDetail(new Request(`${originUrl}/api/documents/${docId}`), docId, {
        sql,
      })
    ).text();

    for (const payload of [revJson, listJson, detailJson]) {
      expect(payload).not.toContain("storageKey");
      expect(payload).not.toContain("storage_key");
      expect(payload).not.toContain("workspaceId");
      expect(payload).not.toContain("workspace_id");
      expect(payload).not.toContain("active_attempt_id");
      expect(payload).not.toContain("smoke-test-bucket");
      expect(payload).not.toContain("gstin");
      expect(payload).not.toContain("taxableValue");
    }
    for (const uploadedPayload of [revJson, detailJson]) {
      expect(uploadedPayload).not.toContain("activeAttemptId");
    }

    // Cross-tenant detail + review symmetry
    mocks.getSession.mockResolvedValue(USER_B);
    const missingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const crossReview = await reviewPost(docId, { reviewStatus: "needs_review" });
    const missingReview = await reviewPost(missingId, { reviewStatus: "needs_review" });
    expect(crossReview.status).toBe(404);
    expect(missingReview.status).toBe(404);
    expect(await crossReview.text()).toBe(await missingReview.text());

    // Compiled Cloudflare Worker smoke dispatch
    if (!existsSync(BUILT_WORKER_PATH)) return;
    const prevDbUrl = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      const mod = (await import(pathToFileURL(BUILT_WORKER_PATH).href)) as {
        default?: {
          fetch?: (req: Request, env: Record<string, unknown>, ctx: unknown) => Promise<Response>;
        };
      };
      const workerFetch = mod.default?.fetch;
      expect(typeof workerFetch).toBe("function");
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const res = await workerFetch!(
          new Request("https://app.test/api/documents", { method }),
          {},
          ctx,
        );
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
      }
      for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
        const res = await workerFetch!(
          new Request(`https://app.test/api/documents/${docId}/review`, { method }),
          {},
          ctx,
        );
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
      }

      const missingOrigin = await workerFetch!(
        new Request(`https://app.test/api/documents/${docId}/review`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reviewStatus: "verified" }),
        }),
        {},
        ctx,
      );
      expect(missingOrigin.status).toBe(403);
    } finally {
      if (prevDbUrl !== undefined) {
        process.env["DATABASE_URL"] = prevDbUrl;
      }
    }
  }, 30_000);
});
