/**
 * Phase 1 — identity and workspace resolution.
 * Covers the single session resolver, same-origin protection, workspace
 * provisioning/ownership, and rejection of client-supplied workspace ids.
 * Uses mocked auth and SQL; it is not a live Neon / Better Auth verification.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/server", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: vi.fn(() => new Headers({ cookie: "from-request-context" })),
  setResponseHeader: vi.fn(),
}));

import {
  assertSameOrigin,
  getOptionalSession,
  getOrCreateWorkspace,
  rejectClientWorkspaceId,
  requireSession,
  requireWorkspaceContext,
} from "@/lib/server/ownership";

const USER = { id: "user-1", name: "Asha Rao", email: "asha@example.com", emailVerified: true };
const SESSION = { user: USER, session: { id: "sess-1", userId: "user-1" } };

function workspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    owner_user_id: "user-1",
    name: "Asha Rao's Workspace",
    created_at: new Date("2026-11-01T00:00:00Z"),
    updated_at: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.getSession.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("requireSession / getOptionalSession", () => {
  it("returns the authenticated user and session id", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(requireSession()).resolves.toEqual({
      user: { id: "user-1", name: "Asha Rao", email: "asha@example.com", emailVerified: true },
      sessionId: "sess-1",
    });
  });

  it("uses the headers of a provided Request, else the current request context", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    const request = new Request("https://app.test/api/x", { headers: { cookie: "from-request" } });
    await requireSession(request);
    expect(mocks.getSession.mock.calls[0]![0].headers).toBe(request.headers);
    await requireSession();
    expect(mocks.getSession.mock.calls[1]![0].headers.get("cookie")).toBe("from-request-context");
  });

  it.each([
    ["no session", null],
    ["session without id", { user: USER, session: {} }],
    ["user without id", { user: {}, session: { id: "s" } }],
  ])("rejects with 401 for %s", async (_name, value) => {
    mocks.getSession.mockResolvedValue(value);
    await expect(requireSession()).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("getOptionalSession returns null when signed out and rethrows real failures", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(getOptionalSession()).resolves.toBeNull();
    mocks.getSession.mockRejectedValue(new Error("db down"));
    await expect(getOptionalSession()).rejects.toThrow("db down");
  });
});

describe("assertSameOrigin", () => {
  const url = "https://app.test/api/things";
  const req = (headers: Record<string, string>) => new Request(url, { method: "POST", headers });

  it("accepts same-origin requests that identify their origin", () => {
    expect(() =>
      assertSameOrigin(req({ "sec-fetch-site": "same-origin", origin: "https://app.test" })),
    ).not.toThrow();
    expect(() => assertSameOrigin(req({ origin: "https://app.test" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ referer: "https://app.test/app" }))).not.toThrow();
  });

  it("is strict: fetch metadata alone, without Origin or Referer, is not enough", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "same-origin" }))).toThrowError(
      expect.objectContaining({ status: 403, code: "FORBIDDEN_ORIGIN" }),
    );
  });

  it.each([
    ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
    ["different origin", { origin: "https://evil.test" }],
    ["null origin", { origin: "null" }],
    ["different referer", { referer: "https://evil.test/page" }],
    ["no origin information at all", {}],
  ])("rejects %s with 403", (_name, headers) => {
    expect(() => assertSameOrigin(req(headers))).toThrowError(
      expect.objectContaining({ status: 403, code: "FORBIDDEN_ORIGIN" }),
    );
  });
});

describe("getOrCreateWorkspace", () => {
  it("resolves the workspace from the authenticated user id only", async () => {
    const query = vi.fn().mockResolvedValue([workspaceRow()]);
    const ws = await getOrCreateWorkspace({ query }, USER);
    expect(ws).toMatchObject({ ownerUserId: "user-1", name: "Asha Rao's Workspace" });
    expect(query.mock.calls[0]![1]).toEqual(["user-1", "Asha Rao's Workspace"]);
  });

  it("uses a neutral default name when the user has no name", async () => {
    const query = vi.fn().mockResolvedValue([workspaceRow({ name: "My Workspace" })]);
    await getOrCreateWorkspace({ query }, { id: "user-1" });
    expect(query.mock.calls[0]![1]).toEqual(["user-1", "My Workspace"]);
  });

  it("fails closed when the resolved workspace is not owned by the user", async () => {
    const query = vi.fn().mockResolvedValue([workspaceRow({ owner_user_id: "someone-else" })]);
    await expect(getOrCreateWorkspace({ query }, USER)).rejects.toMatchObject({
      status: 500,
      code: "WORKSPACE_OWNERSHIP_INVALID",
    });
  });

  it("returns a clear 503 when the workspaces table has not been migrated", async () => {
    const query = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('relation "workspaces" does not exist'), { code: "42P01" }),
      );
    await expect(getOrCreateWorkspace({ query }, USER)).rejects.toMatchObject({
      status: 503,
      code: "WORKSPACE_NOT_CONFIGURED",
    });
  });

  it("rethrows other database errors and fails when no row comes back", async () => {
    await expect(
      getOrCreateWorkspace({ query: vi.fn().mockRejectedValue(new Error("timeout")) }, USER),
    ).rejects.toThrow("timeout");
    await expect(
      getOrCreateWorkspace({ query: vi.fn().mockResolvedValue([]) }, USER),
    ).rejects.toMatchObject({ status: 500, code: "WORKSPACE_ERROR" });
  });
});

describe("requireWorkspaceContext", () => {
  it("combines the session user with their own workspace", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    const query = vi.fn().mockResolvedValue([workspaceRow()]);
    const ctx = await requireWorkspaceContext({ query });
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.workspace.ownerUserId).toBe("user-1");
  });

  it("never touches the database for signed-out callers", async () => {
    mocks.getSession.mockResolvedValue(null);
    const query = vi.fn();
    await expect(requireWorkspaceContext({ query })).rejects.toMatchObject({ status: 401 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("rejectClientWorkspaceId", () => {
  it.each(["workspaceId", "workspace_id", "WorkspaceID", "workspace"])("rejects %s", (key) => {
    expect(() =>
      rejectClientWorkspaceId({ [key]: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" }),
    ).toThrowError(expect.objectContaining({ status: 400, code: "WORKSPACE_ID_NOT_ALLOWED" }));
  });

  it("accepts ordinary input and ignores non-objects", () => {
    expect(() => rejectClientWorkspaceId({ name: "x", batchId: "y" })).not.toThrow();
    expect(() => rejectClientWorkspaceId(null)).not.toThrow();
    expect(() => rejectClientWorkspaceId("workspaceId")).not.toThrow();
  });
});
