/**
 * Phase 1 acceptance checks 1–3 at the API-route level (mocked auth and SQL).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), query: vi.fn() }));

vi.mock("@/lib/auth/server", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: vi.fn(() => new Headers()),
  setResponseHeader: vi.fn(),
}));
vi.mock("@/lib/server/sql", () => ({ getSql: () => ({ query: mocks.query }) }));

import { handleGetWorkspace } from "@/routes/api.workspace";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const row = {
  id: WORKSPACE_ID,
  owner_user_id: "user-1",
  name: "Asha Rao's Workspace",
  created_at: new Date("2026-11-01T00:00:00Z"),
  updated_at: new Date("2026-11-01T00:00:00Z"),
};
const signedIn = {
  user: { id: "user-1", name: "Asha Rao", email: "asha@example.com", emailVerified: true },
  session: { id: "sess-1", userId: "user-1" },
};
const get = (path = "/api/workspace") => handleGetWorkspace(new Request(`https://app.test${path}`));

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.query.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/workspace", () => {
  it("returns only the caller's workspace name, with no internal ids", async () => {
    mocks.getSession.mockResolvedValue(signedIn);
    mocks.query.mockResolvedValue([row]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      workspace: { name: "Asha Rao's Workspace", createdAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(text).not.toContain(WORKSPACE_ID);
    expect(text).not.toContain("user-1");
  });

  it("returns 401 and no private data when signed out", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required.", code: "UNAUTHORIZED" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a forged workspace id without querying the database", async () => {
    mocks.getSession.mockResolvedValue(signedIn);
    const res = await get("/api/workspace?workspaceId=bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("WORKSPACE_ID_NOT_ALLOWED");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("fails clearly (503) when workspace storage is not migrated", async () => {
    mocks.getSession.mockResolvedValue(signedIn);
    mocks.query.mockRejectedValue(Object.assign(new Error("no table"), { code: "42P01" }));
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("WORKSPACE_NOT_CONFIGURED");
  });

  it("hides unexpected error details", async () => {
    mocks.getSession.mockResolvedValue(signedIn);
    mocks.query.mockRejectedValue(new Error("password=secret host=db.internal"));
    const res = await get();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "An unexpected server error occurred." }));
  });
});
