import { describe, expect, it, vi } from "vitest";
import { fetchUserPlan, type PlanSql } from "@/lib/server/user-plan";

describe("fetchUserPlan", () => {
  it("returns the stored plan for the user", async () => {
    const query = vi.fn<PlanSql["query"]>(async () => [{ plan: "business" }]);
    const sql: PlanSql = { query };
    await expect(fetchUserPlan(sql, "u1")).resolves.toBe("business");
    expect(query.mock.calls[0]![1]).toEqual(["u1"]);
  });

  it("defaults to free when the user has no plan row", async () => {
    const sql: PlanSql = { query: vi.fn(async () => []) };
    await expect(fetchUserPlan(sql, "u1")).resolves.toBe("free");
  });

  it("defaults to free for an unrecognised stored value", async () => {
    const sql: PlanSql = { query: vi.fn(async () => [{ plan: "enterprise" }]) };
    await expect(fetchUserPlan(sql, "u1")).resolves.toBe("free");
  });
});
