import { describe, expect, it } from "vitest";
import { isMarketingPath } from "@/lib/gathr/site-paths";

describe("isMarketingPath", () => {
  it.each([
    "/",
    "/product",
    "/how-it-works",
    "/features",
    "/pricing",
    "/privacy",
    "/terms",
    "/contact",
  ])("treats %s as a marketing page", (p) => expect(isMarketingPath(p)).toBe(true));

  it("ignores trailing slashes", () => {
    expect(isMarketingPath("/pricing/")).toBe(true);
  });

  it.each([
    "/app",
    "/app/settings",
    "/login",
    "/register",
    "/verify-email",
    "/api/auth/session",
    "/admin",
    "/nope",
  ])("does not treat %s as a marketing page", (p) => expect(isMarketingPath(p)).toBe(false));
});
