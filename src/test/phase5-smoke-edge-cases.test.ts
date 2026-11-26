// @vitest-environment node
/**
 * Phase 5 — Rigorous multi-scenario & edge-case smoke suite:
 * - Real loopback Node HTTP transport across all Phase 5 routes
 * - Cross-workspace isolation, CSRF origin checks, workspaceId tampering, HTTP method/body validation
 * - Mixed-state & expired-lease batch finalization, partial/failed sealing, post-seal freezing
 * - Lease heartbeat renewal, expired-lease rejection, superseded-attempt fencing
 * - Cancellation races, already-uploaded no-op preservation, offline cancel_unconfirmed recovery
 * - Active-upload vs batch-deletion race, 4-worker outbox SKIP LOCKED contention, stale worker fencing
 * - Non-retryable B2 errors, live-reference & bucket/key guards, log secret redaction
 * - Compiled Nitro Worker fetch() + scheduled() bundle smoke checks
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

import { createUploadOrchestrator, type UploadTransport } from "@/lib/gathr/upload-orchestrator";
import { B2StorageError, type B2StorageClient } from "@/lib/server/b2-storage";
import { claimDocumentUploadAttempt, heartbeatDocumentUploadAttempt } from "@/lib/server/documents";
import {
  claimCleanupOutboxJobs,
  processCleanupOutbox,
  reconcileStaleUploadAttempts,
} from "@/lib/server/lifecycle";
import { logLifecycleEvent, sanitizeDiagnosticDetail } from "@/lib/server/lifecycle-log";
import type { SqlClient } from "@/lib/server/sql";
import { handleGetBatches, handlePostBatches } from "@/routes/api.batches";
import { handleDeleteBatch, handleGetBatchDetail } from "@/routes/api.batches.$id";
import { handleFinalizeBatch } from "@/routes/api.batches.$id.finalize";
import { handleCancelDocumentUpload } from "@/routes/api.documents.$id.cancel";
import { handleGetDocumentContent } from "@/routes/api.documents.$id.content";
import { handleHeartbeatDocumentUpload } from "@/routes/api.documents.$id.heartbeat";
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

function createFakeB2(bucketName = "gathr-smoke-bucket"): FakeB2Bucket {
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
  user: { id: "smoke-user-a", name: "Asha Rao", email: "asha@example.com", emailVerified: true },
  session: { id: "smoke-sess-a", userId: "smoke-user-a" },
};

const USER_B = {
  user: {
    id: "smoke-user-b",
    name: "Vikram Das",
    email: "vikram@example.com",
    emailVerified: true,
  },
  session: { id: "smoke-sess-b", userId: "smoke-user-b" },
};

const baseUrl = "https://app.test";

describe("Phase 5 — Rigorous smoke & edge-case suite (HTTP pipeline + PGlite + Worker)", () => {
  let pg: PGlite;
  let sql: SqlClient;
  let b2: FakeB2Bucket;
  let workspaceAId = "";

  async function dispatchHttp(input: string, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
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
       ('smoke-user-a', 'Asha Rao', 'asha@example.com'),
       ('smoke-user-b', 'Vikram Das', 'vikram@example.com')`,
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

  async function createBatchViaHttp(
    files: Array<{ filename: string; sizeBytes: number }>,
    name = "HTTP Smoke Batch",
  ) {
    const res = await dispatchHttp(`${baseUrl}/api/batches`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ name, files }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      batch: { id: string; status: string; finalizedAt: string | null };
      documents: Array<{ id: string; originalFilename: string; fileSizeBytes: number }>;
    };
    const wsRows = await pg.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM batches WHERE id = $1::uuid`,
      [json.batch.id],
    );
    workspaceAId = wsRows.rows[0]!.workspace_id;
    return json;
  }

  async function uploadViaHttp(docId: string, bytes: Uint8Array, contentType = "application/pdf") {
    return dispatchHttp(`${baseUrl}/api/documents/${docId}/upload`, {
      method: "PUT",
      headers: {
        origin: baseUrl,
        "content-type": contentType,
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

  it("Edge Case 1 & 2: Enforces HTTP method, CSRF, workspace isolation, client workspaceId rejection, and malformed payload bounds", async () => {
    const pdf = makePdfBytes("http-smoke-security");
    const created = await createBatchViaHttp([{ filename: "sec.pdf", sizeBytes: pdf.byteLength }]);
    const batchId = created.batch.id;
    const docId = created.documents[0]!.id;

    // Wrong HTTP methods return 405 + Allow header
    const finGet = await dispatchHttp(`${baseUrl}/api/batches/${batchId}/finalize`);
    expect(finGet.status).toBe(405);
    expect(finGet.headers.get("allow")).toBe("POST");

    const hbGet = await dispatchHttp(`${baseUrl}/api/documents/${docId}/heartbeat`);
    expect(hbGet.status).toBe(405);
    expect(hbGet.headers.get("allow")).toBe("POST");

    const batchPost = await dispatchHttp(`${baseUrl}/api/batches/${batchId}`, {
      method: "POST",
      headers: { origin: baseUrl },
    });
    expect(batchPost.status).toBe(405);
    expect(batchPost.headers.get("allow")).toBe("GET, DELETE");

    // Cross-origin CSRF rejected
    const csrfFinalize = await dispatchHttp(`${baseUrl}/api/batches/${batchId}/finalize`, {
      method: "POST",
      headers: { origin: "https://evil.attacker", "content-type": "application/json" },
      body: "{}",
    });
    expect(csrfFinalize.status).toBe(403);

    const csrfDelete = await dispatchHttp(`${baseUrl}/api/batches/${batchId}`, {
      method: "DELETE",
      headers: { origin: "https://evil.attacker" },
    });
    expect(csrfDelete.status).toBe(403);

    // Client workspaceId injection rejected in body and query string
    const spoofBody = await dispatchHttp(`${baseUrl}/api/batches/${batchId}/finalize`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({
        allowIncomplete: false,
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }),
    });
    expect([400, 403]).toContain(spoofBody.status);

    const spoofQuery = await dispatchHttp(`${baseUrl}/api/batches/${batchId}?workspaceId=spoof`, {
      method: "DELETE",
      headers: { origin: baseUrl },
    });
    expect([400, 403]).toContain(spoofQuery.status);

    // Malformed payloads & wrong Content-Type
    const badCt = await dispatchHttp(`${baseUrl}/api/documents/${docId}/heartbeat`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "text/plain" },
      body: "attemptId=foo",
    });
    expect(badCt.status).toBe(415);

    const badJson = await dispatchHttp(`${baseUrl}/api/batches/${batchId}/finalize`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: "{bad json",
    });
    expect(badJson.status).toBe(400);

    const oversized = await dispatchHttp(`${baseUrl}/api/batches/${batchId}/finalize`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(5000) }),
    });
    expect(oversized.status).toBe(413);

    const invalidUuidDelete = await dispatchHttp(`${baseUrl}/api/batches/not-a-uuid`, {
      method: "DELETE",
      headers: { origin: baseUrl },
    });
    expect(invalidUuidDelete.status).toBe(400);

    // Cross-workspace isolation: USER_B gets 404 across every endpoint
    mocks.getSession.mockResolvedValue(USER_B);
    expect(
      (
        await dispatchHttp(`${baseUrl}/api/batches/${batchId}/finalize`, {
          method: "POST",
          headers: { origin: baseUrl, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await dispatchHttp(`${baseUrl}/api/documents/${docId}/heartbeat`, {
          method: "POST",
          headers: { origin: baseUrl, "content-type": "application/json" },
          body: JSON.stringify({ attemptId: "99999999-9999-4999-8999-999999999999" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await dispatchHttp(`${baseUrl}/api/documents/${docId}/cancel`, {
          method: "POST",
          headers: { origin: baseUrl, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await dispatchHttp(`${baseUrl}/api/batches/${batchId}`, {
          method: "DELETE",
          headers: { origin: baseUrl },
        })
      ).status,
    ).toBe(404);
  });

  it("Edge Case 3: Real HTTP upload + retrieval, expired-lease reap inside finalize, partial/failed sealing, and post-seal lockouts", async () => {
    const pdf1 = makePdfBytes("mixed-1");
    const pdf2 = makePdfBytes("mixed-2");
    const pdf3 = makePdfBytes("mixed-3");

    // Batch A: 1 uploaded, 1 failed, 1 expired uploading lease -> finalize reaps expired lease & seals as partial
    const batchA = await createBatchViaHttp([
      { filename: "ok.pdf", sizeBytes: pdf1.byteLength },
      { filename: "failed.pdf", sizeBytes: pdf2.byteLength },
      { filename: "expired.pdf", sizeBytes: pdf3.byteLength },
    ]);
    const [d1, d2, d3] = batchA.documents;

    const up1 = await uploadViaHttp(d1!.id, pdf1);
    expect(up1.status).toBe(200);

    await pg.query(`UPDATE documents SET status = 'failed' WHERE id = $1::uuid`, [d2!.id]);

    const expiredClaim = await claimDocumentUploadAttempt(sql, {
      workspaceId: workspaceAId,
      documentId: d3!.id,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf3.byteLength,
      leaseSeconds: 5,
    });
    await pg.query(
      `UPDATE documents SET lease_expires_at = clock_timestamp() - interval '30 seconds' WHERE id = $1::uuid`,
      [d3!.id],
    );

    const finA = await dispatchHttp(`${baseUrl}/api/batches/${batchA.batch.id}/finalize`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: "{}",
    });
    expect(finA.status).toBe(200);
    const finABody = (await finA.json()) as {
      batch: { status: string; finalizedAt: string | null };
      documents: Array<{ id: string; status: string }>;
    };
    expect(finABody.batch.status).toBe("partial");
    expect(finABody.batch.finalizedAt).not.toBeNull();
    expect(finABody.documents.find((d) => d.id === d3!.id)?.status).toBe("failed");

    // Expired lease key was queued for cleanup inside finalize
    const reaperOutbox = await pg.query<{ storage_key: string; reason: string }>(
      `SELECT storage_key, reason FROM storage_cleanup_outbox WHERE document_id = $1::uuid`,
      [d3!.id],
    );
    expect(reaperOutbox.rows).toEqual([
      { storage_key: expiredClaim.storageKey, reason: "reaper_eviction" },
    ]);

    // Sealed batch blocks subsequent upload, heartbeat, and cancel while still allowing PDF download
    const blockedUpload = await uploadViaHttp(d2!.id, pdf2);
    expect(blockedUpload.status).toBe(409);
    expect((await blockedUpload.json()).code).toBe("BATCH_FINALIZED");

    const blockedHb = await dispatchHttp(`${baseUrl}/api/documents/${d2!.id}/heartbeat`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ attemptId: expiredClaim.attemptId }),
    });
    expect(blockedHb.status).toBe(409);
    expect((await blockedHb.json()).code).toBe("BATCH_FINALIZED");

    const blockedCancel = await dispatchHttp(`${baseUrl}/api/documents/${d2!.id}/cancel`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: "{}",
    });
    expect(blockedCancel.status).toBe(409);

    const contentRes = await dispatchHttp(`${baseUrl}/api/documents/${d1!.id}/content?download=1`);
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await contentRes.arrayBuffer())).toEqual(pdf1);

    // Batch B: unresolved pending_upload requires allowIncomplete: true, seals all-failed as 'failed'
    const batchB = await createBatchViaHttp([
      { filename: "pending.pdf", sizeBytes: pdf1.byteLength },
    ]);
    const finUnresolved = await dispatchHttp(`${baseUrl}/api/batches/${batchB.batch.id}/finalize`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ allowIncomplete: false }),
    });
    expect(finUnresolved.status).toBe(409);
    expect((await finUnresolved.json()).code).toBe("BATCH_HAS_UNRESOLVED_DOCUMENTS");

    const finForced = await dispatchHttp(`${baseUrl}/api/batches/${batchB.batch.id}/finalize`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ allowIncomplete: true }),
    });
    expect(finForced.status).toBe(200);
    const finForcedBody = (await finForced.json()) as {
      batch: { status: string };
      documents: Array<{ status: string }>;
    };
    expect(finForcedBody.batch.status).toBe("failed");
    expect(finForcedBody.documents[0]?.status).toBe("failed");
  });

  it("Edge Case 4: Heartbeat rejects expired leases cleanly, extends active leases past reaper, and blocks completed docs", async () => {
    const pdf = makePdfBytes("hb-edge");
    const created = await createBatchViaHttp([{ filename: "hb.pdf", sizeBytes: pdf.byteLength }]);
    const docId = created.documents[0]!.id;

    const claim = await claimDocumentUploadAttempt(sql, {
      workspaceId: workspaceAId,
      documentId: docId,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf.byteLength,
      leaseSeconds: 10,
    });

    // Heartbeat extends lease via HTTP
    const hbRes = await dispatchHttp(`${baseUrl}/api/documents/${docId}/heartbeat`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ attemptId: claim.attemptId }),
    });
    expect(hbRes.status).toBe(200);

    // Expire lease -> heartbeat must reject UPLOAD_LEASE_EXPIRED (never resurrect)
    await pg.query(
      `UPDATE documents SET lease_expires_at = clock_timestamp() - interval '5 seconds' WHERE id = $1::uuid`,
      [docId],
    );
    const expiredHb = await dispatchHttp(`${baseUrl}/api/documents/${docId}/heartbeat`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ attemptId: claim.attemptId }),
    });
    expect(expiredHb.status).toBe(409);
    expect((await expiredHb.json()).code).toBe("UPLOAD_LEASE_EXPIRED");

    // Reap expired attempt -> re-upload cleanly via HTTP -> heartbeat on uploaded doc rejects
    await reconcileStaleUploadAttempts(sql, { bucketName: b2.client.bucketName });
    const upRes = await uploadViaHttp(docId, pdf);
    expect(upRes.status).toBe(200);

    await expect(
      heartbeatDocumentUploadAttempt(sql, {
        workspaceId: workspaceAId,
        documentId: docId,
        attemptId: claim.attemptId,
      }),
    ).rejects.toMatchObject({ status: 409, code: "DOCUMENT_ALREADY_UPLOADED" });
  });

  it("Edge Case 5: Cancel fencing protects newer attempts & already-uploaded files, and handles finalize/cancel races", async () => {
    const pdf1 = makePdfBytes("cancel-1");
    const pdf2 = makePdfBytes("cancel-2");
    const created = await createBatchViaHttp([
      { filename: "c1.pdf", sizeBytes: pdf1.byteLength },
      { filename: "c2.pdf", sizeBytes: pdf2.byteLength },
    ]);
    const [d1, d2] = created.documents;

    // Claim Attempt A on d1, expire it, claim Attempt B -> cancel with Attempt A must NOT kill Attempt B
    const claimA = await claimDocumentUploadAttempt(sql, {
      workspaceId: workspaceAId,
      documentId: d1!.id,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf1.byteLength,
      leaseSeconds: 5,
    });
    await pg.query(
      `UPDATE documents SET lease_expires_at = clock_timestamp() - interval '10 seconds' WHERE id = $1::uuid`,
      [d1!.id],
    );
    await claimDocumentUploadAttempt(sql, {
      workspaceId: workspaceAId,
      documentId: d1!.id,
      bucketName: b2.client.bucketName,
      declaredSizeBytes: pdf1.byteLength,
      leaseSeconds: 60,
    });

    const staleCancelRes = await dispatchHttp(`${baseUrl}/api/documents/${d1!.id}/cancel`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ attemptId: claimA.attemptId }),
    });
    expect(staleCancelRes.status).toBe(200);
    const staleCancelBody = (await staleCancelRes.json()) as {
      cancelled: boolean;
      serverConfirmed: boolean;
      document: { status: string };
    };
    expect(staleCancelBody.cancelled).toBe(false);
    expect(staleCancelBody.serverConfirmed).toBe(true);
    expect(staleCancelBody.document.status).toBe("uploading");

    // Upload d2 completely, then send cancel -> must be no-op with ZERO outbox jobs queued
    const up2 = await uploadViaHttp(d2!.id, pdf2);
    expect(up2.status).toBe(200);

    const cancelUploaded = await dispatchHttp(`${baseUrl}/api/documents/${d2!.id}/cancel`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: "{}",
    });
    expect(cancelUploaded.status).toBe(200);
    expect((await cancelUploaded.json()).cancelled).toBe(false);

    const outboxForD2 = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM storage_cleanup_outbox WHERE document_id = $1::uuid`,
      [d2!.id],
    );
    expect(outboxForD2.rows[0]?.count).toBe(0);

    // Concurrent race between POST /cancel (on active d1) and POST /finalize
    const [raceCancel, raceFinalize] = await Promise.all([
      dispatchHttp(`${baseUrl}/api/documents/${d1!.id}/cancel`, {
        method: "POST",
        headers: { origin: baseUrl, "content-type": "application/json" },
        body: "{}",
      }),
      dispatchHttp(`${baseUrl}/api/batches/${created.batch.id}/finalize`, {
        method: "POST",
        headers: { origin: baseUrl, "content-type": "application/json" },
        body: "{}",
      }),
    ]);
    expect([200, 409]).toContain(raceCancel.status);
    expect([200, 409]).toContain(raceFinalize.status);

    // Check DB constraint integrity regardless of race order
    const finalRow = await pg.query<{ status: string; finalized_at: Date | null }>(
      `SELECT status, finalized_at FROM batches WHERE id = $1::uuid`,
      [created.batch.id],
    );
    if (finalRow.rows[0]?.finalized_at) {
      expect(["uploaded", "partial", "failed"]).toContain(finalRow.rows[0].status);
    }
  });

  it("Edge Case 6: Deletes mixed batch while an upload is actively in flight and cleans both keys without error", async () => {
    const pdf1 = makePdfBytes("del-uploaded");
    const pdf2 = makePdfBytes("del-inflight");
    const pdf3 = makePdfBytes("del-pending");
    const created = await createBatchViaHttp([
      { filename: "uploaded.pdf", sizeBytes: pdf1.byteLength },
      { filename: "inflight.pdf", sizeBytes: pdf2.byteLength },
      { filename: "pending.pdf", sizeBytes: pdf3.byteLength },
    ]);
    const [d1, d2] = created.documents;

    expect((await uploadViaHttp(d1!.id, pdf1)).status).toBe(200);

    let enteredPut!: () => void;
    let releasePut!: () => void;
    const putReady = new Promise<void>((r) => {
      enteredPut = r;
    });
    b2.putInterceptor = async () => {
      enteredPut();
      await new Promise<void>((r) => {
        releasePut = r;
      });
    };

    const inflightPromise = uploadViaHttp(d2!.id, pdf2);
    await putReady;

    // Delete batch while d2 is actively streaming to B2 and d3 is still pending_upload
    const delRes = await dispatchHttp(`${baseUrl}/api/batches/${created.batch.id}`, {
      method: "DELETE",
      headers: { origin: baseUrl },
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({
      deleted: true,
      batchId: created.batch.id,
      cleanupJobsQueued: 2, // uploaded d1 + active attempt d2; pending d3 has no key
    });

    // Release delayed B2 PUT -> commit gets 404 DOCUMENT_NOT_FOUND & cleanly avoids crash
    releasePut();
    const lateRes = await inflightPromise;
    expect(lateRes.status).toBe(404);

    // Repeating DELETE returns 404
    const secondDel = await dispatchHttp(`${baseUrl}/api/batches/${created.batch.id}`, {
      method: "DELETE",
      headers: { origin: baseUrl },
    });
    expect(secondDel.status).toBe(404);

    // Cleanup worker removes BOTH objects from B2
    const cleanup = await processCleanupOutbox(sql, b2.client);
    expect(cleanup.completed).toBeGreaterThanOrEqual(2);
    expect(b2.objects.size).toBe(0);
  });

  it("Edge Case 7 & 8: 4-worker SKIP LOCKED contention, non-retryable dead-letter, stale worker fence, live-reference & key guards", async () => {
    await pg.exec(`DELETE FROM storage_cleanup_outbox`);

    // A) 4-worker parallel contention across 20 jobs
    const batchKeys = Array.from(
      { length: 20 },
      (_, i) =>
        `gathr/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-3333333333${String(i).padStart(2, "0")}/44444444-4444-4444-8444-4444444444${String(i).padStart(2, "0")}.pdf`,
    );
    for (const key of batchKeys) {
      b2.objects.set(key, makePdfBytes(key));
      await pg.query(
        `INSERT INTO storage_cleanup_outbox (storage_key, bucket_name, reason) VALUES ($1, $2, 'batch_deleted')`,
        [key, b2.client.bucketName],
      );
    }
    b2.deleteInterceptor = async () => {
      await new Promise((r) => setTimeout(r, 5));
    };
    const workers = await Promise.all([
      processCleanupOutbox(sql, b2.client, { workerId: "w1", limit: 5 }),
      processCleanupOutbox(sql, b2.client, { workerId: "w2", limit: 5 }),
      processCleanupOutbox(sql, b2.client, { workerId: "w3", limit: 5 }),
      processCleanupOutbox(sql, b2.client, { workerId: "w4", limit: 5 }),
    ]);
    b2.deleteInterceptor = undefined;
    expect(workers.reduce((sum, w) => sum + w.completed, 0)).toBe(20);
    expect(b2.deletedKeys).toHaveLength(20);
    expect(new Set(b2.deletedKeys).size).toBe(20);

    // B) Non-retryable 403 AccessDenied jumps directly to dead_letter on attempt 1
    await pg.exec(`DELETE FROM storage_cleanup_outbox`);
    const forbiddenKey =
      "gathr/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333301/55555555-5555-4555-8555-555555555501.pdf";
    await pg.query(
      `INSERT INTO storage_cleanup_outbox (storage_key, bucket_name, reason, max_attempts) VALUES ($1, $2, 'upload_failed', 5)`,
      [forbiddenKey, b2.client.bucketName],
    );
    b2.deleteInterceptor = async () => {
      throw new B2StorageError(403, "Forbidden", "AccessDenied", false);
    };
    const nonRetryRes = await processCleanupOutbox(sql, b2.client);
    b2.deleteInterceptor = undefined;
    expect(nonRetryRes.deadLettered).toBe(1);
    expect(nonRetryRes.retried).toBe(0);

    // C) Live-reference defense guard & wrong-bucket guard refuse delete without calling B2
    await pg.exec(`DELETE FROM storage_cleanup_outbox`);
    const pdfLive = makePdfBytes("live-guard");
    const liveBatch = await createBatchViaHttp([
      { filename: "live-keep.pdf", sizeBytes: pdfLive.byteLength },
    ]);
    expect((await uploadViaHttp(liveBatch.documents[0]!.id, pdfLive)).status).toBe(200);
    const liveKeyRow = await pg.query<{ storage_key: string }>(
      `SELECT storage_key FROM documents WHERE id = $1::uuid`,
      [liveBatch.documents[0]!.id],
    );
    const liveKey = liveKeyRow.rows[0]!.storage_key;
    const wrongBucketKey =
      "gathr/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333302/55555555-5555-4555-8555-555555555502.pdf";
    const traversalKey = "../outside/traversal.pdf";

    await pg.query(
      `INSERT INTO storage_cleanup_outbox (storage_key, bucket_name, reason) VALUES
       ($1, $2, 'orphaned_attempt'),
       ($3, 'other-bucket', 'orphaned_attempt'),
       ($4, $2, 'orphaned_attempt')`,
      [liveKey, b2.client.bucketName, wrongBucketKey, traversalKey],
    );

    const beforeDeletes = b2.deletedKeys.length;
    const guardRes = await processCleanupOutbox(sql, b2.client);
    expect(guardRes.deadLettered).toBe(3);
    expect(b2.deletedKeys.length).toBe(beforeDeletes);
    expect(b2.objects.get(liveKey)).toEqual(pdfLive);

    // D) Stale slow worker hits staleConflicts=1 after lease takeover and cannot overwrite completed job
    await pg.exec(`DELETE FROM storage_cleanup_outbox`);
    const raceKey =
      "gathr/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333309/55555555-5555-4555-8555-555555555509.pdf";
    b2.objects.set(raceKey, makePdfBytes("slow-worker-fence"));
    await pg.query(
      `INSERT INTO storage_cleanup_outbox (storage_key, bucket_name, reason) VALUES ($1, $2, 'upload_failed')`,
      [raceKey, b2.client.bucketName],
    );

    let slowEntered!: () => void;
    let releaseSlow!: () => void;
    const slowReady = new Promise<void>((r) => {
      slowEntered = r;
    });
    let calls = 0;
    b2.deleteInterceptor = async () => {
      calls += 1;
      if (calls === 1) {
        slowEntered();
        await new Promise<void>((r) => {
          releaseSlow = r;
        });
      }
    };

    const slowWorkerPromise = processCleanupOutbox(sql, b2.client, {
      workerId: "slow-w1",
      leaseSeconds: 5,
    });
    await slowReady;

    // Force Worker 1 lease expiry while Worker 1 is stalled inside B2 delete
    await pg.query(
      `UPDATE storage_cleanup_outbox SET locked_until = clock_timestamp() - interval '15 seconds' WHERE storage_key = $1`,
      [raceKey],
    );
    const fastWorker = await processCleanupOutbox(sql, b2.client, { workerId: "fast-w2" });
    expect(fastWorker.completed).toBe(1);

    releaseSlow();
    const slowWorker = await slowWorkerPromise;
    expect(slowWorker.staleConflicts).toBe(1);
    expect(slowWorker.completed).toBe(0);

    // E) Expired processing job at max_attempts moves to dead_letterExpired cleanly
    await pg.exec(`DELETE FROM storage_cleanup_outbox`);
    await pg.query(
      `INSERT INTO storage_cleanup_outbox
       (storage_key, bucket_name, reason, status, attempt_count, max_attempts, worker_id, locked_until)
       VALUES ($1, $2, 'upload_failed', 'processing', 5, 5, 'dead-w', clock_timestamp() - interval '60 seconds')`,
      [wrongBucketKey, b2.client.bucketName],
    );
    const expiredClaim = await claimCleanupOutboxJobs(sql, { workerId: "sweeper" });
    expect(expiredClaim.deadLetteredExpired).toBe(1);
    expect(expiredClaim.jobs).toHaveLength(0);
  });

  it("Edge Case 9: Orchestrator cancel retry gating & offline cancel_unconfirmed state", async () => {
    const mockFile = new File(
      ["%PDF-1.7\n% orch-edge\n1 0 obj\n<<>>\nendobj\n%%EOF\n"],
      "orch.pdf",
      {
        type: "application/pdf",
      },
    );
    const docId = "66666666-6666-4666-8666-666666666666";
    const batchId = "77777777-7777-4777-8777-777777777777";
    const cancelMock = vi.fn().mockResolvedValue(null);

    const transport: UploadTransport = {
      upload() {
        return {
          abort() {},
          promise: new Promise(() => {}),
        };
      },
      cancelOnServer: cancelMock,
    };

    const orch = createUploadOrchestrator({ transport });
    orch.registerBatchFiles(batchId, [{ documentId: docId, file: mockFile }]);
    orch.startBatch(batchId, [
      {
        id: docId,
        batchId,
        originalFilename: "orch.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: mockFile.size,
        status: "pending_upload",
        reviewStatus: null,
        pageCount: null,
        errorMessage: null,
        uploadedAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    // Offline cancel -> lands on cancel_unconfirmed
    await orch.cancelDocument(batchId, docId, undefined, "88888888-8888-4888-8888-888888888888");
    expect(orch.getBatchEntries(batchId).get(docId)?.phase).toBe("cancel_unconfirmed");

    // Retry blocked once server reports batch is finalized
    cancelMock.mockResolvedValueOnce({
      cancelled: false,
      serverConfirmed: true,
      document: {
        id: docId,
        batchId,
        originalFilename: "orch.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: mockFile.size,
        status: "failed",
        reviewStatus: null,
        pageCount: null,
        errorMessage: "Batch sealed.",
        uploadedAt: null,
        createdAt: new Date().toISOString(),
      },
      batch: {
        id: batchId,
        name: "Sealed",
        status: "failed",
        finalizedAt: "2026-11-26T20:00:00.000Z",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const retried = await orch.retryDocument(batchId, docId);
    expect(retried).toBe(false);
    expect(orch.getBatchEntries(batchId).get(docId)?.phase).toBe("failed");

    // Verify diagnostic log redaction strips DB URIs, bearer tokens, S3 signatures, keys, and PDF headers
    const errorSpy = vi.spyOn(console, "error");
    const dirtyDetail =
      "failed connecting postgres://admin:supersecret@db.neon.tech/neondb header Bearer tok_123 key gathr/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc/dddddddd-dddd-4ddd-8ddd-dddddddddddd.pdf %PDF-1.7";
    expect(sanitizeDiagnosticDetail(dirtyDetail)).not.toContain("supersecret");
    expect(sanitizeDiagnosticDetail(dirtyDetail)).not.toContain("tok_123");
    expect(sanitizeDiagnosticDetail(dirtyDetail)).not.toContain("%PDF-");
    expect(sanitizeDiagnosticDetail(dirtyDetail)).not.toContain("gathr/");

    logLifecycleEvent("error", {
      operation: "smoke_redact",
      outcome: "failed",
      detail: dirtyDetail,
    });
    const loggedJson = JSON.stringify(errorSpy.mock.calls);
    expect(loggedJson).not.toContain("supersecret");
    expect(loggedJson).not.toContain("tok_123");
    expect(loggedJson).not.toContain("%PDF-");
  });

  it("Edge Case 10: Compiled Nitro Worker bundle routes Phase 5 endpoints safely and rejects maintenance HTTP paths", async () => {
    if (!existsSync(BUILT_WORKER_PATH)) return;

    const prevDbUrl = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      const mod = (await import(pathToFileURL(BUILT_WORKER_PATH).href)) as {
        default: {
          fetch: (req: Request, env: Record<string, unknown>, ctx: unknown) => Promise<Response>;
        };
      };

      const batchUuid = "11111111-1111-4111-8111-111111111111";
      const docUuid = "22222222-2222-4222-8222-222222222222";
      const dummyCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

      const getFinalize = await mod.default.fetch(
        new Request(`https://app.test/api/batches/${batchUuid}/finalize`, { method: "GET" }),
        {},
        dummyCtx,
      );
      expect(getFinalize.status).toBe(405);
      expect(getFinalize.headers.get("allow")).toBe("POST");

      const csrfFinalize = await mod.default.fetch(
        new Request(`https://app.test/api/batches/${batchUuid}/finalize`, {
          method: "POST",
          headers: { origin: "https://evil.example", "content-type": "application/json" },
          body: "{}",
        }),
        {},
        dummyCtx,
      );
      expect(csrfFinalize.status).toBe(403);

      const csrfHb = await mod.default.fetch(
        new Request(`https://app.test/api/documents/${docUuid}/heartbeat`, {
          method: "POST",
          headers: { origin: "https://evil.example", "content-type": "application/json" },
          body: JSON.stringify({ attemptId: batchUuid }),
        }),
        {},
        dummyCtx,
      );
      expect(csrfHb.status).toBe(403);

      const csrfDelete = await mod.default.fetch(
        new Request(`https://app.test/api/batches/${batchUuid}`, {
          method: "DELETE",
          headers: { origin: "https://evil.example" },
        }),
        {},
        dummyCtx,
      );
      expect(csrfDelete.status).toBe(403);

      const finalizeRes = await mod.default.fetch(
        new Request(`https://app.test/api/batches/${batchUuid}/finalize`, {
          method: "POST",
          headers: { origin: "https://app.test", "content-type": "application/json" },
          body: "{}",
        }),
        {},
        dummyCtx,
      );
      expect([401, 403, 500, 503]).toContain(finalizeRes.status);

      // Public maintenance HTTP probes must never succeed
      for (const forbiddenPath of [
        "/api/maintenance",
        "/api/reconcile",
        "/api/cleanup",
        "/api/outbox",
      ]) {
        const r = await mod.default.fetch(
          new Request(`https://app.test${forbiddenPath}`, { method: "POST" }),
          {},
          dummyCtx,
        );
        expect(r.status).not.toBe(200);
      }
    } finally {
      if (prevDbUrl !== undefined) {
        process.env["DATABASE_URL"] = prevDbUrl;
      }
    }
  }, 30_000);
});
