/**
 * Adversarial ownership-security tests — Phase 1 Acceptance Checks 3 & 4.
 *
 * Verifies that requireOwnedBatch and requireOwnedDocument refuse cross-workspace
 * access even when the caller supplies a valid resource ID belonging to a *different*
 * workspace, and that forged / malformed IDs are rejected before any DB query fires.
 *
 * These tests use a lightweight mock SqlClient so no live DB is required.
 */
import { describe, expect, it, vi } from "vitest";
import { requireOwnedBatch, requireOwnedDocument } from "@/lib/server/ownership";

// ---------------------------------------------------------------------------
// Mock SqlClient factory
// ---------------------------------------------------------------------------

/** Returns a SqlClient whose `query` always resolves to the provided rows. */
function makeSql(rows: Record<string, unknown>[]): { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue(rows) };
}

/** Returns a SqlClient that should NOT be called (asserts no DB round-trip). */
function makeSqlShouldNotBeCalled(): { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn().mockRejectedValue(new Error("DB query must not be called")),
  };
}

// ---------------------------------------------------------------------------
// Canonical UUIDs used across tests
// ---------------------------------------------------------------------------
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const BATCH_ID = "11111111-1111-4111-1111-111111111111";
const DOC_ID = "22222222-2222-4222-2222-222222222222";

// ---------------------------------------------------------------------------
// requireOwnedBatch — cross-workspace access
// ---------------------------------------------------------------------------
describe("requireOwnedBatch — cross-workspace access control", () => {
  it("returns the batch when workspace_id matches", async () => {
    const row = {
      id: BATCH_ID,
      workspace_id: WORKSPACE_A,
      name: "Invoice Run Q1",
      status: "complete",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const sql = makeSql([row]);

    const batch = await requireOwnedBatch(sql, WORKSPACE_A, BATCH_ID);

    expect(batch.id).toBe(BATCH_ID);
    expect(batch.workspaceId).toBe(WORKSPACE_A);
    // Confirm the query included both the batch ID AND the caller's workspace ID
    expect(sql.query).toHaveBeenCalledWith(expect.stringContaining("workspace_id"), [
      BATCH_ID,
      WORKSPACE_A,
    ]);
  });

  it("returns 404 when the batch exists but belongs to a different workspace (cross-workspace read attempt)", async () => {
    // DB returns empty set because the WHERE clause filters by workspace_id
    const sql = makeSql([]);

    await expect(requireOwnedBatch(sql, WORKSPACE_A, BATCH_ID)).rejects.toMatchObject({
      status: 404,
      code: "BATCH_NOT_FOUND",
    });
  });

  it("never leaks WORKSPACE_B data to a WORKSPACE_A caller even if DB row exists in another workspace", async () => {
    // Simulate an adversary who knows a valid batch ID in workspace B and calls with workspace A
    const sql = makeSql([]); // server returns nothing because workspace_id filter excludes it

    await expect(requireOwnedBatch(sql, WORKSPACE_A, BATCH_ID)).rejects.toMatchObject({
      status: 404,
    });

    // The query must be called with WORKSPACE_A as the second parameter — not WORKSPACE_B
    expect(sql.query).toHaveBeenCalledWith(expect.any(String), [BATCH_ID, WORKSPACE_A]);
  });
});

// ---------------------------------------------------------------------------
// requireOwnedBatch — invalid / forged IDs
// ---------------------------------------------------------------------------
describe("requireOwnedBatch — forged / malformed batch IDs", () => {
  it("rejects a non-UUID batch ID without hitting the database", async () => {
    const sql = makeSqlShouldNotBeCalled();

    await expect(requireOwnedBatch(sql, WORKSPACE_A, "../../etc/passwd")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_BATCH_ID",
    });

    expect(sql.query).not.toHaveBeenCalled();
  });

  it("rejects an empty string batch ID without hitting the database", async () => {
    const sql = makeSqlShouldNotBeCalled();

    await expect(requireOwnedBatch(sql, WORKSPACE_A, "")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_BATCH_ID",
    });

    expect(sql.query).not.toHaveBeenCalled();
  });

  it("rejects a SQL-injection-style batch ID without hitting the database", async () => {
    const sql = makeSqlShouldNotBeCalled();

    await expect(
      requireOwnedBatch(sql, WORKSPACE_A, "'; DROP TABLE batches; --"),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_BATCH_ID" });

    expect(sql.query).not.toHaveBeenCalled();
  });

  it("rejects a UUID with wrong segment lengths without hitting the database", async () => {
    const sql = makeSqlShouldNotBeCalled();
    // Extra character in the first segment — not a valid UUID format
    await expect(
      requireOwnedBatch(sql, WORKSPACE_A, "111111111-1111-4111-1111-111111111111"),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_BATCH_ID" });

    expect(sql.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// requireOwnedDocument — cross-workspace access
// ---------------------------------------------------------------------------
describe("requireOwnedDocument — cross-workspace access control", () => {
  it("returns the document when workspace_id matches", async () => {
    const row = {
      id: DOC_ID,
      workspace_id: WORKSPACE_A,
      batch_id: BATCH_ID,
      original_filename: "invoice.pdf",
      mime_type: "application/pdf",
      file_size_bytes: 204800,
      storage_key: null,
      active_attempt_id: null,
      lease_expires_at: null,
      upload_started_at: null,
      status: "pending",
      page_count: null,
      error_message: null,
      uploaded_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const sql = makeSql([row]);

    const doc = await requireOwnedDocument(sql, WORKSPACE_A, DOC_ID);

    expect(doc.id).toBe(DOC_ID);
    expect(doc.workspaceId).toBe(WORKSPACE_A);
    expect(sql.query).toHaveBeenCalledWith(expect.stringContaining("workspace_id"), [
      DOC_ID,
      WORKSPACE_A,
    ]);
  });

  it("returns 404 when the document exists but belongs to a different workspace (cross-workspace read attempt)", async () => {
    const sql = makeSql([]);

    await expect(requireOwnedDocument(sql, WORKSPACE_A, DOC_ID)).rejects.toMatchObject({
      status: 404,
      code: "DOCUMENT_NOT_FOUND",
    });
  });

  it("never leaks storage_key or document content from workspace B to a workspace A caller", async () => {
    // Adversary knows a valid document ID in workspace B
    // Server returns nothing because WHERE workspace_id = WORKSPACE_A excludes it
    const sql = makeSql([]);

    await expect(requireOwnedDocument(sql, WORKSPACE_A, DOC_ID)).rejects.toMatchObject({
      status: 404,
    });

    expect(sql.query).toHaveBeenCalledWith(expect.any(String), [DOC_ID, WORKSPACE_A]);
  });
});

// ---------------------------------------------------------------------------
// requireOwnedDocument — invalid / forged IDs
// ---------------------------------------------------------------------------
describe("requireOwnedDocument — forged / malformed document IDs", () => {
  it("rejects a non-UUID document ID without hitting the database", async () => {
    const sql = makeSqlShouldNotBeCalled();

    await expect(requireOwnedDocument(sql, WORKSPACE_A, "not-a-uuid")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_DOCUMENT_ID",
    });

    expect(sql.query).not.toHaveBeenCalled();
  });

  it("rejects an empty string document ID without hitting the database", async () => {
    const sql = makeSqlShouldNotBeCalled();

    await expect(requireOwnedDocument(sql, WORKSPACE_A, "")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_DOCUMENT_ID",
    });

    expect(sql.query).not.toHaveBeenCalled();
  });

  it("rejects a SQL-injection-style document ID without hitting the database", async () => {
    const sql = makeSqlShouldNotBeCalled();

    await expect(requireOwnedDocument(sql, WORKSPACE_A, "1 OR 1=1")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_DOCUMENT_ID",
    });

    expect(sql.query).not.toHaveBeenCalled();
  });
});
