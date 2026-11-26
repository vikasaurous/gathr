// @vitest-environment node
/**
 * Phase 3 — API route security & PGlite batch persistence / idempotency tests.
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

import { MAX_FILE_BYTES, MAX_FILES_PER_BATCH } from "@/lib/gathr/ingestion-types";
import {
  createBatchInWorkspace,
  getWorkspaceBatchDetail,
  listWorkspaceBatches,
} from "@/lib/server/batches";
import type { SqlClient } from "@/lib/server/sql";
import { handleGetBatchDetail } from "@/routes/api.batches.$id";
import { handleGetBatches, handlePostBatches } from "@/routes/api.batches";

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

const USER_A = {
  user: { id: "user-p3-a", name: "Asha Rao", email: "asha@example.com", emailVerified: true },
  session: { id: "sess-a", userId: "user-p3-a" },
};

const USER_B = {
  user: { id: "user-p3-b", name: "Rohan Das", email: "rohan@example.com", emailVerified: true },
  session: { id: "sess-b", userId: "user-p3-b" },
};

function postBatchesReq(
  body: unknown,
  headers: Record<string, string> = {},
  url = "https://app.test/api/batches",
) {
  return new Request(url, {
    method: "POST",
    headers: {
      origin: "https://app.test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("Phase 3 API route boundary validation & security", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getSql.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rejects unauthenticated requests before hitting SQL", async () => {
    mocks.getSession.mockResolvedValue(null);
    const query = vi.fn();
    mocks.getSql.mockReturnValue({ query });

    const getListRes = await handleGetBatches(new Request("https://app.test/api/batches"));
    expect(getListRes.status).toBe(401);

    const postRes = await handlePostBatches(
      postBatchesReq({ files: [{ filename: "a.pdf", sizeBytes: 100 }] }),
    );
    expect(postRes.status).toBe(401);

    const getDetailRes = await handleGetBatchDetail(
      new Request("https://app.test/api/batches/11111111-1111-4111-1111-111111111111"),
      "11111111-1111-4111-1111-111111111111",
    );
    expect(getDetailRes.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects cross-origin POST /api/batches with 403", async () => {
    const query = vi.fn();
    mocks.getSql.mockReturnValue({ query });
    mocks.getSession.mockResolvedValue(USER_A);

    const res = await handlePostBatches(
      new Request("https://app.test/api/batches", {
        method: "POST",
        headers: { origin: "https://evil.test", "content-type": "application/json" },
        body: JSON.stringify({ files: [{ filename: "a.pdf", sizeBytes: 100 }] }),
      }),
    );
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects client-supplied workspaceId in query string or body", async () => {
    mocks.getSession.mockResolvedValue(USER_A);
    const query = vi.fn().mockResolvedValue([
      {
        id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        owner_user_id: USER_A.user.id,
        name: "Asha Rao's Workspace",
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    mocks.getSql.mockReturnValue({ query });

    const queryRes = await handlePostBatches(
      postBatchesReq(
        { files: [{ filename: "a.pdf", sizeBytes: 100 }] },
        {},
        "https://app.test/api/batches?workspaceId=bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      ),
    );
    expect(queryRes.status).toBe(400);
    expect((await queryRes.json()).code).toBe("WORKSPACE_ID_NOT_ALLOWED");

    const bodyRes = await handlePostBatches(
      postBatchesReq({
        workspaceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        files: [{ filename: "a.pdf", sizeBytes: 100 }],
      }),
    );
    expect(bodyRes.status).toBe(400);
    expect((await bodyRes.json()).code).toBe("WORKSPACE_ID_NOT_ALLOWED");
  });

  it("rejects invalid payloads when client validation is bypassed", async () => {
    mocks.getSession.mockResolvedValue(USER_A);
    const query = vi.fn().mockResolvedValue([
      {
        id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        owner_user_id: USER_A.user.id,
        name: "Asha Rao's Workspace",
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    mocks.getSql.mockReturnValue({ query });

    // Non-JSON content-type -> 415
    const badContentType = await handlePostBatches(
      new Request("https://app.test/api/batches", {
        method: "POST",
        headers: { origin: "https://app.test", "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(badContentType.status).toBe(415);

    // Oversized JSON body > 64 KiB -> 413
    const hugeBody = JSON.stringify({
      name: "x".repeat(70_000),
      files: [{ filename: "a.pdf", sizeBytes: 100 }],
    });
    const tooLarge = await handlePostBatches(postBatchesReq(hugeBody));
    expect(tooLarge.status).toBe(413);

    // Invalid payloads (non-PDF, 0 bytes, >50 MiB, >25 files, traversal, bad idempotency key) -> 400
    const badBodies = [
      "{not-json",
      { files: [] },
      { files: [{ filename: "not-a-pdf.exe", mimeType: "application/pdf", sizeBytes: 100 }] },
      { files: [{ filename: "bad.pdf", mimeType: "text/html", sizeBytes: 100 }] },
      { files: [{ filename: "zero.pdf", sizeBytes: 0 }] },
      { files: [{ filename: "over50.pdf", sizeBytes: MAX_FILE_BYTES + 1 }] },
      { files: [{ filename: "../../etc/passwd.pdf", sizeBytes: 100 }] },
      {
        files: Array.from({ length: MAX_FILES_PER_BATCH + 1 }, (_, i) => ({
          filename: `f-${i}.pdf`,
          sizeBytes: 100,
        })),
      },
    ];

    for (const body of badBodies) {
      const res = await handlePostBatches(postBatchesReq(body));
      expect(res.status).toBe(400);
    }

    const badKey = await handlePostBatches(
      postBatchesReq(
        { files: [{ filename: "a.pdf", sizeBytes: 100 }] },
        { "idempotency-key": "bad key" },
      ),
    );
    expect(badKey.status).toBe(400);
  });

  it("returns 503 clearly when database migrations are incomplete (42703)", async () => {
    mocks.getSession.mockResolvedValue(USER_A);
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
          owner_user_id: USER_A.user.id,
          name: "Asha Rao's Workspace",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ])
      .mockRejectedValueOnce(
        Object.assign(new Error("column idempotency_key does not exist"), { code: "42703" }),
      );
    mocks.getSql.mockReturnValue({ query });

    const res = await handlePostBatches(
      postBatchesReq(
        { files: [{ filename: "a.pdf", sizeBytes: 100 }] },
        { "idempotency-key": "key-1" },
      ),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("STORAGE_NOT_MIGRATED");
  });
});

describe("Phase 3 end-to-end persistence, idempotency, and isolation against PGlite", () => {
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
    await pg.exec(
      `INSERT INTO "user"(id, name, email) VALUES
       ('user-p3-a', 'Asha Rao', 'asha@example.com'),
       ('user-p3-b', 'Rohan Das', 'rohan@example.com')`,
    );
    sql = makePgSqlClient(pg);
    mocks.getSql.mockReturnValue(sql);
  }, 90_000);

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(() => {
    mocks.getSql.mockReturnValue(sql);
  });

  it("persists a multi-PDF batch, keeps separate documents, disambiguates collisions, and recovers on reload", async () => {
    mocks.getSession.mockResolvedValue(USER_A);

    const createRes = await handlePostBatches(
      postBatchesReq(
        {
          name: "November Bills",
          files: [
            { filename: "C:\\fakepath\\invoice.pdf", mimeType: "application/pdf", sizeBytes: 1200 },
            { filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 2400 },
            { filename: "credit-note.pdf", sizeBytes: 3600 },
          ],
        },
        { "idempotency-key": "idem-create-1" },
      ),
    );

    expect(createRes.status).toBe(201);
    expect(createRes.headers.get("cache-control")).toBe("private, no-store");
    expect(createRes.headers.get("x-content-type-options")).toBe("nosniff");

    const text = await createRes.text();
    expect(text).not.toContain("workspaceId");
    expect(text).not.toContain("storageKey");
    expect(text).not.toContain("idempotencyKey");

    const created = JSON.parse(text);
    expect(created.idempotentReplay).toBe(false);
    expect(created.batch.name).toBe("November Bills");
    expect(created.batch.status).toBe("uploading");
    expect(created.documents).toHaveLength(3);
    expect(created.documents.map((d: { originalFilename: string }) => d.originalFilename)).toEqual([
      "invoice.pdf",
      "invoice (2).pdf",
      "credit-note.pdf",
    ]);
    expect(created.documents.every((d: { status: string }) => d.status === "pending_upload")).toBe(
      true,
    );
    expect(created.documents.every((d: { reviewStatus: null }) => d.reviewStatus === null)).toBe(
      true,
    );

    // Simulate page reload via GET /api/batches and GET /api/batches/:id
    const listRes = await handleGetBatches(new Request("https://app.test/api/batches"));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.batches[0]).toMatchObject({
      id: created.batch.id,
      name: "November Bills",
      documentCount: 3,
      pendingCount: 3,
      uploadedCount: 0,
      failedCount: 0,
      totalSizeBytes: 7200,
    });

    const detailRes = await handleGetBatchDetail(
      new Request(`https://app.test/api/batches/${created.batch.id}`),
      created.batch.id,
    );
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.batch.id).toBe(created.batch.id);
    expect(detailBody.documents.map((d: { id: string }) => d.id)).toEqual(
      created.documents.map((d: { id: string }) => d.id),
    );
  });

  it("prevents duplicate batches on double-click / concurrent submission and rejects mismatched payload reuse (409)", async () => {
    mocks.getSession.mockResolvedValue(USER_A);

    const payload = {
      name: "Concurrent Run",
      files: [
        { filename: "first.pdf", mimeType: "application/pdf", sizeBytes: 512 },
        { filename: "second.pdf", mimeType: "application/pdf", sizeBytes: 1024 },
      ],
    };

    const req1 = handlePostBatches(
      postBatchesReq(payload, { "idempotency-key": "double-click-1" }),
    );
    const req2 = handlePostBatches(
      postBatchesReq(payload, { "idempotency-key": "double-click-1" }),
    );
    const [res1, res2] = await Promise.all([req1, req2]);

    const body1 = await res1.json();
    const body2 = await res2.json();
    expect([res1.status, res2.status].sort()).toEqual([200, 201]);
    expect(body1.batch.id).toBe(body2.batch.id);
    expect(body1.documents.map((d: { id: string }) => d.id)).toEqual(
      body2.documents.map((d: { id: string }) => d.id),
    );

    const dbCount = await pg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM "batches" WHERE "idempotency_key" = 'double-click-1'`,
    );
    expect(dbCount.rows[0]!.c).toBe(1);

    // Reusing the same key with a different payload must be rejected with 409
    const conflictRes = await handlePostBatches(
      postBatchesReq(
        { name: "Different Run", files: [{ filename: "other.pdf", sizeBytes: 999 }] },
        { "idempotency-key": "double-click-1" },
      ),
    );
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json()).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("isolates persisted batches across workspaces and prevents cross-workspace detail access", async () => {
    mocks.getSession.mockResolvedValue(USER_A);
    const createdARes = await handlePostBatches(
      postBatchesReq(
        { name: "Workspace A Private", files: [{ filename: "a-only.pdf", sizeBytes: 500 }] },
        { "idempotency-key": "shared-key-between-tenants" },
      ),
    );
    expect(createdARes.status).toBe(201);
    const batchAId = (await createdARes.json()).batch.id;

    // Switch to User B
    mocks.getSession.mockResolvedValue(USER_B);
    const listB = await handleGetBatches(new Request("https://app.test/api/batches"));
    expect((await listB.json()).batches).toEqual([]);

    // Cross-workspace read by valid UUID returns 404 without leaking existence
    const crossRead = await handleGetBatchDetail(
      new Request(`https://app.test/api/batches/${batchAId}`),
      batchAId,
    );
    expect(crossRead.status).toBe(404);
    expect((await crossRead.json()).code).toBe("BATCH_NOT_FOUND");

    // Nonexistent UUID follows the same 404 policy
    const missingRead = await handleGetBatchDetail(
      new Request("https://app.test/api/batches/99999999-9999-4999-9999-999999999999"),
      "99999999-9999-4999-9999-999999999999",
    );
    expect(missingRead.status).toBe(404);

    // Same Idempotency-Key string in Workspace B does not collide with Workspace A
    const createdBRes = await handlePostBatches(
      postBatchesReq(
        { name: "Workspace B Private", files: [{ filename: "b-only.pdf", sizeBytes: 600 }] },
        { "idempotency-key": "shared-key-between-tenants" },
      ),
    );
    expect(createdBRes.status).toBe(201);
    expect((await createdBRes.json()).batch.id).not.toBe(batchAId);
  });

  it("rolls back batch creation atomically if document constraints reject a row", async () => {
    const wsRows = await pg.query<{ id: string }>(
      `SELECT id FROM "workspaces" WHERE "owner_user_id" = 'user-p3-b' LIMIT 1`,
    );
    const wsB = wsRows.rows[0]!.id;
    const beforeCount = (await listWorkspaceBatches(sql, wsB)).length;

    await expect(
      createBatchInWorkspace(
        sql,
        wsB,
        {
          name: "Should Rollback",
          files: [{ filename: "bad.pdf", sizeBytes: MAX_FILE_BYTES + 1 }],
        },
        "rollback-check-1",
      ),
    ).rejects.toThrow();

    const afterCount = (await listWorkspaceBatches(sql, wsB)).length;
    expect(afterCount).toBe(beforeCount);
    await expect(
      getWorkspaceBatchDetail(sql, wsB, "88888888-8888-4888-8888-888888888888"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
