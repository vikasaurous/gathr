// @vitest-environment node
/**
 * Phase 5 — Batch lifecycle and failure recovery acceptance checks (1–12)
 * against PGlite + committed migrations + mocked Backblaze B2 transport +
 * Cloudflare Worker scheduled entrypoint verification.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

import { isValidBatchTransition, isValidDocumentTransition } from "@/lib/gathr/ingestion-types";
import { B2StorageError, type B2StorageClient } from "@/lib/server/b2-storage";
import {
  claimDocumentUploadAttempt,
  commitDocumentUploadAttempt,
  heartbeatDocumentUploadAttempt,
} from "@/lib/server/documents";
import {
  claimCleanupOutboxJobs,
  processCleanupOutbox,
  reconcileStaleUploadAttempts,
} from "@/lib/server/lifecycle";
import { runScheduledMaintenance } from "@/lib/server/maintenance";
import type { SqlClient } from "@/lib/server/sql";
import { handleDeleteBatch, handleGetBatchDetail } from "@/routes/api.batches.$id";
import { handleFinalizeBatch } from "@/routes/api.batches.$id.finalize";
import { handleGetBatches, handlePostBatches } from "@/routes/api.batches";
import { handleHeartbeatDocumentUpload } from "@/routes/api.documents.$id.heartbeat";
import { handleUploadDocument } from "@/routes/api.documents.$id.upload";
import serverEntry from "@/server";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const ROUTES_DIR = fileURLToPath(new URL("../routes", import.meta.url));
const BUILT_WORKER_PATH = fileURLToPath(new URL("../../.output/server/index.mjs", import.meta.url));
const BUILT_WRANGLER_PATH = fileURLToPath(
  new URL("../../.output/server/wrangler.json", import.meta.url),
);

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

function makePdfBytes(tag: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);
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
  deleteInterceptor?: ((key: string) => Promise<void>) | undefined;
}

function createFakeB2(bucketName = "gathr-p5-test"): FakeB2Bucket {
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
        const bytes = objects.get(key);
        if (!bytes) throw new B2StorageError(404, "Not found", "NoSuchKey", false);
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
        if (state.deleteInterceptor) {
          await state.deleteInterceptor(key);
        }
        deletedKeys.push(key);
        return { deleted: objects.delete(key) };
      },
    },
  };
  return state;
}

const USER_A = {
  user: { id: "user-p5-a", name: "Kiran Sen", email: "kiran@example.com", emailVerified: true },
  session: { id: "sess-p5-a", userId: "user-p5-a" },
};

const USER_B = {
  user: { id: "user-p5-b", name: "Neha Kulkarni", email: "neha@example.com", emailVerified: true },
  session: { id: "sess-p5-b", userId: "user-p5-b" },
};

function makeUploadReq(docId: string, bytes: Uint8Array): Request {
  return new Request(`https://app.test/api/documents/${docId}/upload`, {
    method: "PUT",
    headers: {
      origin: "https://app.test",
      "content-type": "application/pdf",
      "content-length": String(bytes.byteLength),
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("Phase 5 — State model contracts", () => {
  it("keeps technical upload transitions valid and blocks mutations once finalized", () => {
    expect(isValidBatchTransition("uploading", "partial", false)).toBe(true);
    expect(isValidBatchTransition("partial", "uploading", false)).toBe(true);
    expect(isValidBatchTransition("partial", "uploading", true)).toBe(false);
    expect(isValidBatchTransition("uploaded", "partial", true)).toBe(false);

    expect(isValidDocumentTransition("pending_upload", "uploading")).toBe(true);
    expect(isValidDocumentTransition("failed", "uploading")).toBe(true);
    expect(isValidDocumentTransition("uploaded", "failed")).toBe(false);
    expect(isValidDocumentTransition("uploaded", "uploading")).toBe(false);
  });
});

describe("Phase 5 — Acceptance checks 1–12 against PGlite & mocked B2", () => {
  let pg: PGlite;
  let sql: SqlClient;
  let b2: FakeB2Bucket;
  let workspaceId: string;

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
       ('user-p5-a', 'Kiran Sen', 'kiran@example.com'),
       ('user-p5-b', 'Neha Kulkarni', 'neha@example.com')`,
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  async function createBatch(
    files: Array<{ filename: string; sizeBytes: number }>,
    name = "Phase 5 Batch",
  ) {
    const res = await handlePostBatches(
      new Request("https://app.test/api/batches", {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json" },
        body: JSON.stringify({ name, files }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      batch: { id: string; status: string; finalizedAt: string | null };
      documents: Array<{ id: string; originalFilename: string; fileSizeBytes: number }>;
    };
    const wsRows = await pg.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM batches WHERE id = $1::uuid`,
      [body.batch.id],
    );
    workspaceId = wsRows.rows[0]!.workspace_id;
    return body;
  }

  it("1. Refuses finalization while an upload lease is active without failing the active upload", async () => {
    const pdf = makePdfBytes("active-finalize");
    const created = await createBatch([{ filename: "live.pdf", sizeBytes: pdf.byteLength }]);
    const batchId = created.batch.id;
    const docId = created.documents[0]!.id;

    let enteredPut!: () => void;
    let releasePut!: () => void;
    const putStarted = new Promise<void>((r) => {
      enteredPut = r;
    });
    b2.putInterceptor = async () => {
      enteredPut();
      await new Promise<void>((r) => {
        releasePut = r;
      });
    };

    const uploadPromise = handleUploadDocument(makeUploadReq(docId, pdf), docId, {
      sql,
      b2: b2.client,
      leaseSeconds: 60,
    });
    await putStarted;

    // Attempt to finalize while upload lease is active
    const finRes = await handleFinalizeBatch(
      new Request(`https://app.test/api/batches/${batchId}/finalize`, {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json" },
        body: "{}",
      }),
      batchId,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(finRes.status).toBe(409);
    expect((await finRes.json()).code).toBe("UPLOAD_IN_PROGRESS");

    // Active document must NOT be marked failed
    const midDoc = await pg.query<{ status: string }>(
      `SELECT status FROM documents WHERE id = $1::uuid`,
      [docId],
    );
    expect(midDoc.rows[0]?.status).toBe("uploading");

    // Let active upload finish, then finalize succeeds
    releasePut();
    const uploadRes = await uploadPromise;
    expect(uploadRes.status).toBe(200);

    const finOk = await handleFinalizeBatch(
      new Request(`https://app.test/api/batches/${batchId}/finalize`, {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json" },
        body: "{}",
      }),
      batchId,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(finOk.status).toBe(200);
    const finBody = (await finOk.json()) as {
      batch: { status: string; finalizedAt: string | null };
      alreadyFinalized: boolean;
    };
    expect(finBody.batch.status).toBe("uploaded");
    expect(finBody.batch.finalizedAt).not.toBeNull();
    expect(finBody.alreadyFinalized).toBe(false);

    // Repeating finalize is idempotent
    const finReplay = await handleFinalizeBatch(
      new Request(`https://app.test/api/batches/${batchId}/finalize`, {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json" },
        body: "{}",
      }),
      batchId,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(finReplay.status).toBe(200);
    expect((await finReplay.json()).alreadyFinalized).toBe(true);
  });

  it("2. Races upload claim against finalization repeatedly with one valid winner and seals batch", async () => {
    const pdf = makePdfBytes("race-claim-finalize");

    for (let trial = 0; trial < 5; trial++) {
      const created = await createBatch([
        { filename: `race-${trial}.pdf`, sizeBytes: pdf.byteLength },
      ]);
      const batchId = created.batch.id;
      const docId = created.documents[0]!.id;

      // Mark doc failed first so both claim and finalize are eligible concurrently
      await pg.query(`UPDATE documents SET status = 'failed' WHERE id = $1::uuid`, [docId]);

      const claimOp = claimDocumentUploadAttempt(sql, {
        workspaceId,
        documentId: docId,
        bucketName: b2.client.bucketName,
        declaredSizeBytes: pdf.byteLength,
      }).then(
        (claim) => ({ ok: true as const, claim }),
        (err: { status?: number; code?: string }) => ({ ok: false as const, err }),
      );

      const finalizeOp = handleFinalizeBatch(
        new Request(`https://app.test/api/batches/${batchId}/finalize`, {
          method: "POST",
          headers: { origin: "https://app.test", "content-type": "application/json" },
          body: "{}",
        }),
        batchId,
        { sql, bucketName: b2.client.bucketName },
      );

      const [claimOutcome, finalizeOutcome] =
        trial % 2 === 0
          ? await Promise.all([claimOp, finalizeOp])
          : await Promise.all([finalizeOp, claimOp]).then(([f, c]) => [c, f] as const);

      if (claimOutcome.ok) {
        expect(finalizeOutcome.status).toBe(409);
        const batchRow = await pg.query<{ finalized_at: Date | null; status: string }>(
          `SELECT finalized_at, status FROM batches WHERE id = $1::uuid`,
          [batchId],
        );
        expect(batchRow.rows[0]?.finalized_at).toBeNull();
        expect(batchRow.rows[0]?.status).toBe("uploading");
      } else {
        expect(claimOutcome.err).toMatchObject({ status: 409, code: "BATCH_FINALIZED" });
        expect(finalizeOutcome.status).toBe(200);
        // No upload can begin after the batch is sealed
        const afterSealRes = await handleUploadDocument(makeUploadReq(docId, pdf), docId, {
          sql,
          b2: b2.client,
        });
        expect(afterSealRes.status).toBe(409);
        expect((await afterSealRes.json()).code).toBe("BATCH_FINALIZED");
      }
    }
  });

  it("3. Retries a failed document with a new attemptId/key, supports heartbeat renewal, and rejects late old attempts", async () => {
    const pdf1 = makePdfBytes("attempt-one");
    const pdf2 = makePdfBytes("attempt-two-retried");
    const created = await createBatch([
      { filename: "retry-doc.pdf", sizeBytes: pdf1.byteLength },
      { filename: "ok-doc.pdf", sizeBytes: pdf1.byteLength },
    ]);
    const docRetryId = created.documents[0]!.id;
    const docOkId = created.documents[1]!.id;

    // Upload ok-doc first and confirm it stays intact (not duplicated) when docRetry is retried
    const okRes = await handleUploadDocument(makeUploadReq(docOkId, pdf1), docOkId, {
      sql,
      b2: b2.client,
    });
    expect(okRes.status).toBe(200);

    // Attempt 1 fails in B2 -> doc transitions to failed, batch to partial
    b2.putInterceptor = async () => {
      throw new B2StorageError(503, "B2 down", "ServiceUnavailable", true);
    };
    const failRes = await handleUploadDocument(makeUploadReq(docRetryId, pdf1), docRetryId, {
      sql,
      b2: b2.client,
    });
    expect(failRes.status).toBe(502);
    b2.putInterceptor = undefined;

    // Claim Attempt 2 on retryable failed doc (also update expected size for pdf2 if different, keep same size here)
    await pg.query(`UPDATE documents SET file_size_bytes = $1 WHERE id = $2::uuid`, [
      pdf2.byteLength,
      docRetryId,
    ]);
    const claimA = await claimDocumentUploadAttempt(sql, {
      workspaceId,
      documentId: docRetryId,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf2.byteLength,
      leaseSeconds: 60,
    });

    // Heartbeat extends active lease and rejects wrong attemptId
    const hbOk = await handleHeartbeatDocumentUpload(
      new Request(`https://app.test/api/documents/${docRetryId}/heartbeat`, {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json" },
        body: JSON.stringify({ attemptId: claimA.attemptId }),
      }),
      docRetryId,
      { sql, leaseSeconds: 120 },
    );
    expect(hbOk.status).toBe(200);

    const wrongAttemptId = "99999999-9999-4999-8999-999999999999";
    await expect(
      heartbeatDocumentUploadAttempt(sql, {
        workspaceId,
        documentId: docRetryId,
        attemptId: wrongAttemptId,
      }),
    ).rejects.toMatchObject({ status: 409, code: "UPLOAD_ATTEMPT_SUPERSEDED" });

    // Expire claimA and retry with claimB
    await pg.query(
      `UPDATE documents SET lease_expires_at = now() - interval '15 seconds' WHERE id = $1::uuid`,
      [docRetryId],
    );
    const claimB = await claimDocumentUploadAttempt(sql, {
      workspaceId,
      documentId: docRetryId,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf2.byteLength,
      leaseSeconds: 60,
    });
    expect(claimB.attemptId).not.toBe(claimA.attemptId);
    expect(claimB.storageKey).not.toBe(claimA.storageKey);

    await b2.client.putObject({
      key: claimB.storageKey,
      body: new ReadableStream({
        start(c) {
          c.enqueue(pdf2);
          c.close();
        },
      }),
      contentLength: pdf2.byteLength,
    });
    await commitDocumentUploadAttempt(sql, {
      workspaceId,
      documentId: docRetryId,
      attemptId: claimB.attemptId,
      storageKey: claimB.storageKey,
      bucketName: b2.client.bucketName,
    });

    // Late Attempt A cannot overwrite claimB
    await expect(
      commitDocumentUploadAttempt(sql, {
        workspaceId,
        documentId: docRetryId,
        attemptId: claimA.attemptId,
        storageKey: claimA.storageKey,
        bucketName: b2.client.bucketName,
      }),
    ).rejects.toMatchObject({ status: 409, code: "UPLOAD_ATTEMPT_SUPERSEDED" });

    // Exactly 1 doc row for docOk and 1 doc row for docRetry (no duplication)
    const docsInBatch = await pg.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM documents WHERE batch_id = $1::uuid ORDER BY created_at`,
      [created.batch.id],
    );
    expect(docsInBatch.rows).toHaveLength(2);
    expect(docsInBatch.rows[0]?.storage_key).toBe(claimB.storageKey);
  });

  it("4. Stale reconciliation & cleanup do not delete a newer attempt or lose the old key when an old request is still running", async () => {
    const pdfOld = makePdfBytes("stale-still-running");
    const pdfNew = makePdfBytes("stale-still-running");
    const created = await createBatch([
      { filename: "stale-race.pdf", sizeBytes: pdfOld.byteLength },
    ]);
    const docId = created.documents[0]!.id;

    let releaseOldPut!: () => void;
    let oldPutStarted!: () => void;
    const oldPutReady = new Promise<void>((r) => {
      oldPutStarted = r;
    });
    let oldKey = "";
    let putCount = 0;

    b2.putInterceptor = async ({ key }) => {
      putCount += 1;
      if (putCount === 1) {
        oldKey = key;
        oldPutStarted();
        await new Promise<void>((r) => {
          releaseOldPut = r;
        });
      }
    };

    const oldUploadPromise = handleUploadDocument(makeUploadReq(docId, pdfOld), docId, {
      sql,
      b2: b2.client,
      leaseSeconds: 10,
    });
    await oldPutReady;

    // Expire old attempt's lease while old B2 upload is still blocked in flight
    await pg.query(
      `UPDATE documents SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1::uuid`,
      [docId],
    );

    // Run stale reconciliation
    const reaperRes = await reconcileStaleUploadAttempts(sql, {
      bucketName: b2.client.bucketName,
    });
    expect(reaperRes.reconciled).toBeGreaterThanOrEqual(1);

    const outboxAfterReaper = await pg.query<{
      storage_key: string;
      reason: string;
      status: string;
    }>(`SELECT storage_key, reason, status FROM storage_cleanup_outbox WHERE storage_key = $1`, [
      oldKey,
    ]);
    expect(outboxAfterReaper.rows[0]).toEqual({
      storage_key: oldKey,
      reason: "reaper_eviction",
      status: "pending",
    });

    // Retry with newer attempt B while old request is still alive
    b2.putInterceptor = undefined;
    const retryRes = await handleUploadDocument(makeUploadReq(docId, pdfNew), docId, {
      sql,
      b2: b2.client,
      leaseSeconds: 60,
    });
    expect(retryRes.status).toBe(200);

    const docAfterRetry = await pg.query<{ storage_key: string }>(
      `SELECT storage_key FROM documents WHERE id = $1::uuid`,
      [docId],
    );
    const newKey = docAfterRetry.rows[0]!.storage_key;
    expect(newKey).not.toBe(oldKey);

    // Cleanup worker runs -> deletes ONLY oldKey, NEVER newKey
    const cleanupRes = await processCleanupOutbox(sql, b2.client);
    expect(cleanupRes.completed).toBeGreaterThanOrEqual(1);
    expect(b2.deletedKeys).not.toContain(newKey);
    expect(b2.objects.get(newKey)).toEqual(pdfNew);

    // Old request finishes late -> fails with 409 and re-queues oldKey safely without touching newKey
    releaseOldPut();
    const oldRes = await oldUploadPromise;
    expect(oldRes.status).toBe(409);
    expect(b2.objects.get(newKey)).toEqual(pdfNew);

    // Second cleanup pass cleans late-written oldKey
    await processCleanupOutbox(sql, b2.client);
    expect(b2.objects.has(oldKey)).toBe(false);
    expect(b2.objects.get(newKey)).toEqual(pdfNew);
  });

  it("5. Preserves attempt identity on documents when outbox insertion fails during stale reconciliation", async () => {
    const pdf = makePdfBytes("reaper-outbox-fail");
    const created = await createBatch([{ filename: "reaper-fail.pdf", sizeBytes: pdf.byteLength }]);
    const docId = created.documents[0]!.id;

    const claim = await claimDocumentUploadAttempt(sql, {
      workspaceId,
      documentId: docId,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf.byteLength,
      leaseSeconds: 5,
    });
    await pg.query(
      `UPDATE documents SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1::uuid`,
      [docId],
    );

    // Inject DB failure on storage_cleanup_outbox inserts
    await pg.exec(`
      CREATE OR REPLACE FUNCTION fail_outbox_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected outbox failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_outbox_insert
        BEFORE INSERT ON storage_cleanup_outbox
        FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert();
    `);

    try {
      const failedPass = await reconcileStaleUploadAttempts(sql, {
        bucketName: b2.client.bucketName,
      });
      expect(failedPass.failed).toBeGreaterThanOrEqual(1);
      expect(failedPass.reconciled).toBe(0);

      // Document MUST retain status='uploading' and active_attempt_id so a later pass can reconcile it
      const docState = await pg.query<{ status: string; active_attempt_id: string | null }>(
        `SELECT status, active_attempt_id FROM documents WHERE id = $1::uuid`,
        [docId],
      );
      expect(docState.rows[0]).toEqual({
        status: "uploading",
        active_attempt_id: claim.attemptId,
      });
    } finally {
      await pg.exec(`DROP TRIGGER IF EXISTS trg_fail_outbox_insert ON storage_cleanup_outbox;`);
    }

    // Later reconciliation pass succeeds and queues the exact attempt key
    const recoveryPass = await reconcileStaleUploadAttempts(sql, {
      bucketName: b2.client.bucketName,
    });
    expect(recoveryPass.reconciled).toBeGreaterThanOrEqual(1);

    const outbox = await pg.query<{ storage_key: string; reason: string }>(
      `SELECT storage_key, reason FROM storage_cleanup_outbox WHERE document_id = $1::uuid`,
      [docId],
    );
    expect(outbox.rows).toEqual([{ storage_key: claim.storageKey, reason: "reaper_eviction" }]);
  });

  it("6. Rolls back batch deletion completely if cleanup outbox insertion fails", async () => {
    const pdf = makePdfBytes("delete-rollback");
    const created = await createBatch([{ filename: "keep-me.pdf", sizeBytes: pdf.byteLength }]);
    const batchId = created.batch.id;
    const docId = created.documents[0]!.id;

    const upRes = await handleUploadDocument(makeUploadReq(docId, pdf), docId, {
      sql,
      b2: b2.client,
    });
    expect(upRes.status).toBe(200);

    await pg.exec(`
      CREATE OR REPLACE FUNCTION fail_outbox_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected delete outbox failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_outbox_insert
        BEFORE INSERT ON storage_cleanup_outbox
        FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert();
    `);

    try {
      const delRes = await handleDeleteBatch(
        new Request(`https://app.test/api/batches/${batchId}`, {
          method: "DELETE",
          headers: { origin: "https://app.test" },
        }),
        batchId,
        { sql, bucketName: b2.client.bucketName },
      );
      expect(delRes.status).toBe(500);
    } finally {
      await pg.exec(`DROP TRIGGER IF EXISTS trg_fail_outbox_insert ON storage_cleanup_outbox;`);
    }

    // Batch and document metadata MUST still exist intact
    const detailRes = await handleGetBatchDetail(
      new Request(`https://app.test/api/batches/${batchId}`),
      batchId,
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as { batch: { id: string }; documents: unknown[] };
    expect(detailBody.batch.id).toBe(batchId);
    expect(detailBody.documents).toHaveLength(1);
  });

  it("7. Runs two cleanup workers concurrently without conflicting ownership or duplicate deletes", async () => {
    await pg.exec(`DELETE FROM storage_cleanup_outbox`);

    const keys = Array.from(
      { length: 6 },
      (_, i) =>
        `gathr/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-33333333333${i}/44444444-4444-4444-8444-44444444444${i}.pdf`,
    );
    for (const k of keys) {
      b2.objects.set(k, makePdfBytes(k));
      await pg.query(
        `INSERT INTO storage_cleanup_outbox (storage_key, bucket_name, reason) VALUES ($1, $2, 'batch_deleted')`,
        [k, b2.client.bucketName],
      );
    }

    // Introduce small async delay on deleteObject so both workers overlap in time
    b2.deleteInterceptor = async () => {
      await new Promise((r) => setTimeout(r, 15));
    };

    const [res1, res2] = await Promise.all([
      processCleanupOutbox(sql, b2.client, { workerId: "worker-1", limit: 3 }),
      processCleanupOutbox(sql, b2.client, { workerId: "worker-2", limit: 3 }),
    ]);

    expect(res1.completed + res2.completed).toBe(6);
    expect(b2.deletedKeys).toHaveLength(6);
    expect(new Set(b2.deletedKeys).size).toBe(6);
  });

  it("8. Recovers stranded processing cleanup jobs after worker lease expiry without letting stale worker overwrite", async () => {
    await pg.exec(`DELETE FROM storage_cleanup_outbox`);

    const key =
      "gathr/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333339/44444444-4444-4444-8444-444444444449.pdf";
    b2.objects.set(key, makePdfBytes("crash-recovery"));
    await pg.query(
      `INSERT INTO storage_cleanup_outbox (storage_key, bucket_name, reason) VALUES ($1, $2, 'orphaned_attempt')`,
      [key, b2.client.bucketName],
    );

    // Worker 1 claims the job and "crashes" without completing it
    const claimed = await claimCleanupOutboxJobs(sql, {
      workerId: "crashed-worker",
      limit: 5,
      leaseSeconds: 30,
    });
    expect(claimed.jobs).toHaveLength(1);
    expect(claimed.jobs[0]?.status).toBe("processing");
    expect(claimed.jobs[0]?.attemptCount).toBe(1);

    // Expire crashed worker's lease
    await pg.query(
      `UPDATE storage_cleanup_outbox SET locked_until = now() - interval '10 seconds' WHERE id = $1::uuid`,
      [claimed.jobs[0]!.id],
    );

    // Worker 2 recovers and completes the job
    const recovered = await processCleanupOutbox(sql, b2.client, { workerId: "recovery-worker" });
    expect(recovered.claimed).toBe(1);
    expect(recovered.completed).toBe(1);
    expect(b2.objects.has(key)).toBe(false);

    const row = await pg.query<{ status: string; attempt_count: number; worker_id: string | null }>(
      `SELECT status, attempt_count, worker_id FROM storage_cleanup_outbox WHERE id = $1::uuid`,
      [claimed.jobs[0]!.id],
    );
    expect(row.rows[0]).toEqual({
      status: "completed",
      attempt_count: 2,
      worker_id: null,
    });
  });

  it("9. Keeps failed B2 deletions retryable with observable error and transitions to dead_letter after max_attempts", async () => {
    await pg.exec(`DELETE FROM storage_cleanup_outbox`);

    const key =
      "gathr/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333338/44444444-4444-4444-8444-444444444448.pdf";
    b2.objects.set(key, makePdfBytes("retry-b2-delete"));
    await pg.query(
      `INSERT INTO storage_cleanup_outbox (storage_key, bucket_name, reason, max_attempts) VALUES ($1, $2, 'upload_failed', 2)`,
      [key, b2.client.bucketName],
    );

    b2.deleteInterceptor = async () => {
      throw new B2StorageError(503, "B2 unavailable", "ServiceUnavailable", true);
    };

    // Attempt 1 fails transiently -> remains pending for retry
    const first = await processCleanupOutbox(sql, b2.client, { baseRetrySeconds: 1 });
    expect(first.retried).toBe(1);
    expect(first.deadLettered).toBe(0);

    const afterFirst = await pg.query<{
      status: string;
      attempt_count: number;
      last_error: string | null;
    }>(
      `SELECT status, attempt_count, last_error FROM storage_cleanup_outbox WHERE storage_key = $1`,
      [key],
    );
    expect(afterFirst.rows[0]?.status).toBe("pending");
    expect(afterFirst.rows[0]?.attempt_count).toBe(1);
    expect(afterFirst.rows[0]?.last_error).toContain("503");

    // Make retry due immediately -> Attempt 2 hits max_attempts -> dead_letter
    await pg.query(
      `UPDATE storage_cleanup_outbox SET scheduled_at = now() - interval '5 seconds' WHERE storage_key = $1`,
      [key],
    );
    const second = await processCleanupOutbox(sql, b2.client, { baseRetrySeconds: 1 });
    expect(second.deadLettered).toBe(1);

    const afterSecond = await pg.query<{ status: string; processed_at: Date | null }>(
      `SELECT status, processed_at FROM storage_cleanup_outbox WHERE storage_key = $1`,
      [key],
    );
    expect(afterSecond.rows[0]?.status).toBe("dead_letter");
    expect(afterSecond.rows[0]?.processed_at).not.toBeNull();
  });

  it("10 & 11. Wires Cloudflare Worker scheduled handler + Cron Trigger, runs both reconciliation and outbox cleanup, and exposes no public maintenance route", async () => {
    const pdf = makePdfBytes("scheduled-maintenance");
    const created = await createBatch([{ filename: "cron-stale.pdf", sizeBytes: pdf.byteLength }]);
    const docId = created.documents[0]!.id;

    // Seed an expired uploading attempt with bytes already in B2
    const claim = await claimDocumentUploadAttempt(sql, {
      workspaceId,
      documentId: docId,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf.byteLength,
      leaseSeconds: 5,
    });
    b2.objects.set(claim.storageKey, pdf);
    await pg.query(
      `UPDATE documents SET lease_expires_at = now() - interval '60 seconds' WHERE id = $1::uuid`,
      [docId],
    );

    // Invoke scheduled maintenance directly and via src/server.ts scheduled handler
    const waitUntilPromises: Promise<unknown>[] = [];
    await serverEntry.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now() },
      {
        DATABASE_URL: "postgres://mocked",
        B2_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
        B2_S3_REGION: "us-west-004",
        B2_BUCKET_NAME: b2.client.bucketName,
        B2_APPLICATION_KEY_ID: "test-key-id",
        B2_APPLICATION_KEY: "test-secret",
      },
      { waitUntil: (p) => waitUntilPromises.push(p) },
    );
    await Promise.all(waitUntilPromises);

    // Re-run with fake B2 delete transport to confirm both reconciliation and cleanup complete
    const maintRes = await runScheduledMaintenance({
      sql,
      b2: b2.client,
      cron: "*/5 * * * *",
    });
    expect(maintRes.executed).toBe(true);
    expect(maintRes.reconciliation).toBeDefined();
    expect(maintRes.cleanup).toBeDefined();

    const docAfterCron = await pg.query<{ status: string; active_attempt_id: string | null }>(
      `SELECT status, active_attempt_id FROM documents WHERE id = $1::uuid`,
      [docId],
    );
    expect(docAfterCron.rows[0]).toEqual({ status: "failed", active_attempt_id: null });

    // Check built Cloudflare Worker deployment output if present
    if (existsSync(BUILT_WRANGLER_PATH) && existsSync(BUILT_WORKER_PATH)) {
      const wrangler = JSON.parse(readFileSync(BUILT_WRANGLER_PATH, "utf8")) as {
        main?: string;
        triggers?: { crons?: string[] };
      };
      expect(wrangler.main).toBe("index.mjs");
      expect(wrangler.triggers?.crons).toEqual(["*/5 * * * *"]);

      const workerSource = readFileSync(BUILT_WORKER_PATH, "utf8");
      expect(workerSource).toContain("cloudflare:scheduled");
      expect(workerSource).toContain("runScheduledMaintenance");

      const builtMod = (await import(pathToFileURL(BUILT_WORKER_PATH).href)) as {
        default: {
          scheduled: (
            controller: { cron: string; scheduledTime: number },
            env: Record<string, unknown>,
            ctx: { waitUntil: (p: Promise<unknown>) => void },
          ) => void;
        };
      };
      expect(typeof builtMod.default.scheduled).toBe("function");

      const builtPromises: Promise<unknown>[] = [];
      builtMod.default.scheduled(
        { cron: "*/5 * * * *", scheduledTime: Date.now() },
        {},
        { waitUntil: (p) => builtPromises.push(p) },
      );
      await Promise.all(builtPromises);
    }

    // Confirm NO public route exposes reconciliation or cleanup outbox processing
    const routeFiles = readdirSync(ROUTES_DIR).filter((f) => f.startsWith("api."));
    for (const file of routeFiles) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      expect(src).not.toContain("reconcileStaleUploadAttempts");
      expect(src).not.toContain("processCleanupOutbox");
      expect(src).not.toContain("runScheduledMaintenance");
    }
  }, 30_000);

  it("12. Deletes a batch with uploaded documents, removes it from workspace lists, preserves cleanup outbox obligations, and never logs secrets or keys", async () => {
    const infoSpy = vi.spyOn(console, "info");
    const pdf1 = makePdfBytes("delete-one");
    const pdf2 = makePdfBytes("delete-two");
    const created = await createBatch([
      { filename: "del-1.pdf", sizeBytes: pdf1.byteLength },
      { filename: "del-2.pdf", sizeBytes: pdf2.byteLength },
    ]);
    const batchId = created.batch.id;
    const doc1Id = created.documents[0]!.id;
    const doc2Id = created.documents[1]!.id;

    expect(
      (await handleUploadDocument(makeUploadReq(doc1Id, pdf1), doc1Id, { sql, b2: b2.client }))
        .status,
    ).toBe(200);
    expect(
      (await handleUploadDocument(makeUploadReq(doc2Id, pdf2), doc2Id, { sql, b2: b2.client }))
        .status,
    ).toBe(200);

    const keyRows = await pg.query<{ storage_key: string }>(
      `SELECT storage_key FROM documents WHERE batch_id = $1::uuid ORDER BY created_at`,
      [batchId],
    );
    const keys = keyRows.rows.map((r) => r.storage_key);
    expect(keys).toHaveLength(2);
    expect(b2.objects.size).toBeGreaterThanOrEqual(2);

    // Cross-workspace delete attempt by USER_B must fail with 404
    mocks.getSession.mockResolvedValue(USER_B);
    const crossDel = await handleDeleteBatch(
      new Request(`https://app.test/api/batches/${batchId}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      batchId,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(crossDel.status).toBe(404);

    // Owner deletes batch
    mocks.getSession.mockResolvedValue(USER_A);
    const delRes = await handleDeleteBatch(
      new Request(`https://app.test/api/batches/${batchId}`, {
        method: "DELETE",
        headers: { origin: "https://app.test" },
      }),
      batchId,
      { sql, bucketName: b2.client.bucketName },
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({
      deleted: true,
      batchId,
      cleanupJobsQueued: 2,
    });

    // Batch and documents are gone from relational tables and workspace list
    const listRes = await handleGetBatches(new Request("https://app.test/api/batches"));
    const listBody = (await listRes.json()) as { batches: Array<{ id: string }> };
    expect(listBody.batches.some((b) => b.id === batchId)).toBe(false);

    const docCount = await pg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM documents WHERE batch_id = $1::uuid`,
      [batchId],
    );
    expect(docCount.rows[0]?.c).toBe(0);

    // Outbox obligations survive parent deletion and delete the exact B2 objects when processed
    const outboxRows = await pg.query<{ storage_key: string; reason: string; status: string }>(
      `SELECT storage_key, reason, status FROM storage_cleanup_outbox WHERE batch_id = $1::uuid ORDER BY storage_key`,
      [batchId],
    );
    expect(outboxRows.rows).toHaveLength(2);
    expect(
      outboxRows.rows.every((r) => r.reason === "batch_deleted" && r.status === "pending"),
    ).toBe(true);

    const workerRes = await processCleanupOutbox(sql, b2.client);
    expect(workerRes.completed).toBeGreaterThanOrEqual(2);
    for (const k of keys) {
      expect(b2.objects.has(k)).toBe(false);
    }

    // Verify diagnostic logs identify operation/ids without raw keys, secrets, or PDF bytes
    const logged = JSON.stringify(infoSpy.mock.calls);
    expect(logged).toContain("delete_batch");
    expect(logged).not.toContain("%PDF-");
    for (const k of keys) {
      expect(logged).not.toContain(k);
    }
  });
});
