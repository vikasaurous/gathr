import { describe, expect, it, vi } from "vitest";
import { isAdminUser, parseAdminEmails } from "@/lib/server/admin-access";

vi.mock("@tanstack/react-start/server-only", () => ({}));
vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn() }));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: vi.fn(),
  setResponseHeader: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({ auth: { api: { getSession: vi.fn() } } }));

import {
  ADMIN_PAGE_SIZE,
  escapeLike,
  fetchAdminOverview,
  fetchAdminUsers,
  setUserPlan,
  type AdminSql,
} from "@/lib/server/admin";

describe("parseAdminEmails", () => {
  it("returns [] for unset or blank", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails("")).toEqual([]);
    expect(parseAdminEmails(" , ,")).toEqual([]);
  });
  it("normalises, trims and de-duplicates", () => {
    expect(parseAdminEmails(" Me@X.com, me@x.com ,b@y.com")).toEqual(["me@x.com", "b@y.com"]);
  });
});

describe("isAdminUser", () => {
  const owner = { email: "Owner@Example.com", emailVerified: true };
  it("allows a verified allowlisted email (case-insensitive)", () => {
    expect(isAdminUser(owner, "owner@example.com")).toBe(true);
  });
  it("denies when allowlist is unset or empty (fail closed)", () => {
    expect(isAdminUser(owner, undefined)).toBe(false);
    expect(isAdminUser(owner, "")).toBe(false);
  });
  it("denies unverified emails even if allowlisted", () => {
    expect(
      isAdminUser({ email: "owner@example.com", emailVerified: false }, "owner@example.com"),
    ).toBe(false);
    expect(isAdminUser({ email: "owner@example.com" }, "owner@example.com")).toBe(false);
  });
  it("denies other users, partial matches and missing users", () => {
    expect(
      isAdminUser({ email: "other@example.com", emailVerified: true }, "owner@example.com"),
    ).toBe(false);
    expect(
      isAdminUser({ email: "owner@example.com.evil.io", emailVerified: true }, "owner@example.com"),
    ).toBe(false);
    expect(isAdminUser(null, "owner@example.com")).toBe(false);
    expect(isAdminUser({ email: null, emailVerified: true }, "owner@example.com")).toBe(false);
  });
});

describe("escapeLike", () => {
  it("escapes wildcard characters", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});

describe("fetchAdminUsers", () => {
  function makeSql(): { sql: AdminSql; query: ReturnType<typeof vi.fn> } {
    const query = vi.fn(async (text: string) =>
      text.includes("count(*)::int AS total")
        ? [{ total: 3 }]
        : [
            {
              id: "u1",
              name: "A",
              email: "a@x.com",
              emailVerified: true,
              createdAt: new Date("2026-11-01T00:00:00Z"),
              providers: ["credential", "google"],
              plan: "pro",
              last_sign_in_at: null,
              active_sessions: 2,
            },
          ],
    );
    return { sql: { query }, query };
  }

  it("parameterises the search and never interpolates user input", async () => {
    const { sql, query } = makeSql();
    await fetchAdminUsers(sql, { page: 2, query: "a%'; DROP TABLE user;--" });
    for (const call of query.mock.calls) {
      expect(String(call[0])).not.toContain("DROP TABLE");
    }
    const listCall = query.mock.calls.find((c) => String(c[0]).includes("LIMIT"))!;
    expect(listCall[1]).toEqual(["%a\\%'; DROP TABLE user;--%", ADMIN_PAGE_SIZE, ADMIN_PAGE_SIZE]);
  });

  it("maps rows and clamps invalid pages", async () => {
    const { sql } = makeSql();
    const res = await fetchAdminUsers(sql, { page: -5, query: "" });
    expect(res.page).toBe(1);
    expect(res.total).toBe(3);
    expect(res.rows[0]).toMatchObject({
      id: "u1",
      emailVerified: true,
      providers: ["credential", "google"],
      plan: "pro",
      lastSignInAt: null,
      activeSessions: 2,
      createdAt: "2026-11-01T00:00:00.000Z",
    });
  });

  it("never selects secret columns", async () => {
    const { sql, query } = makeSql();
    await fetchAdminUsers(sql, { page: 1, query: "" });
    const all = query.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toMatch(
      /"password"|"accessToken"|"refreshToken"|"idToken"|s\."token"|ipAddress/,
    );
  });
});

describe("plans", () => {
  it("falls back to free for unknown plan values", async () => {
    const sql: AdminSql = {
      query: vi.fn(async (text: string) =>
        text.includes("count(*)::int AS total")
          ? [{ total: 1 }]
          : [
              {
                id: "u1",
                name: "A",
                email: "a@x.com",
                emailVerified: true,
                createdAt: new Date(),
                providers: [],
                plan: "enterprise",
                last_sign_in_at: null,
                active_sessions: 0,
              },
            ],
      ),
    };
    const res = await fetchAdminUsers(sql, { page: 1, query: "" });
    expect(res.rows[0]?.plan).toBe("free");
  });

  it("computes free count as users without a paid plan row", async () => {
    const sql: AdminSql = {
      query: vi.fn(async () => [
        {
          total_users: 10,
          verified_users: 8,
          new_7d: 1,
          new_30d: 3,
          active_sessions: 2,
          pro_users: 3,
          business_users: 1,
        },
      ]),
    };
    const o = await fetchAdminOverview(sql);
    expect(o.planCounts).toEqual({ free: 6, pro: 3, business: 1 });
  });

  it("setUserPlan rejects invalid plans and users without touching the DB", async () => {
    const query = vi.fn();
    const sql: AdminSql = { query };
    await expect(
      setUserPlan(sql, { userId: "u1", plan: "gold", adminId: "a" }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_PLAN" });
    await expect(
      setUserPlan(sql, { userId: "  ", plan: "pro", adminId: "a" }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_USER" });
    expect(query).not.toHaveBeenCalled();
  });

  it("setUserPlan upserts with parameters and 404s for a missing user", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ userId: "u1", plan: "pro" }])
      .mockResolvedValueOnce([]);
    const sql: AdminSql = { query };
    await expect(
      setUserPlan(sql, { userId: "u1", plan: "pro", adminId: "admin1" }),
    ).resolves.toEqual({ userId: "u1", plan: "pro" });
    expect(query.mock.calls[0]![1]).toEqual(["u1", "pro", "admin1"]);
    await expect(
      setUserPlan(sql, { userId: "ghost", plan: "pro", adminId: "admin1" }),
    ).rejects.toMatchObject({ status: 404, code: "USER_NOT_FOUND" });
  });
});
