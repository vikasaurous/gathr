import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { PLAN_IDS } from "@/lib/gathr/plans";
import { auth } from "@/lib/auth/server";
import { getServerEnv } from "@/lib/server/env";
import { isAdminUser } from "@/lib/server/admin-access";
import {
  fetchAdminOverview,
  fetchAdminUsers,
  getAdminSql,
  requireAdmin,
  setUserPlan,
  type AdminOverview,
  type AdminUserPage,
} from "@/lib/server/admin";

/**
 * Lightweight check used by the route guard and navigation.
 * Returns only a boolean — never the allowlist — and never throws for non-admins.
 */
export const getAdminAccessFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ isAdmin: boolean }> => {
    try {
      const session = await auth.api.getSession({ headers: getRequestHeaders() });
      const isAdmin = isAdminUser(session?.user, getServerEnv().ADMIN_EMAILS);
      setResponseHeader("Cache-Control", "private, no-store");
      return { isAdmin };
    } catch (err) {
      console.error("[getAdminAccessFn] failed:", err);
      return { isAdmin: false };
    }
  },
);

export const getAdminOverviewFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminOverview> => {
    await requireAdmin();
    return fetchAdminOverview(getAdminSql());
  },
);

const usersInput = z.object({
  page: z.number().int().min(1).max(100000).default(1),
  q: z.string().trim().max(100).default(""),
});

export const listAdminUsersFn = createServerFn({ method: "GET" })
  .inputValidator(usersInput)
  .handler(async ({ data }): Promise<AdminUserPage> => {
    await requireAdmin();
    return fetchAdminUsers(getAdminSql(), { page: data.page, query: data.q });
  });

const planInput = z.object({
  userId: z.string().trim().min(1).max(128),
  plan: z.enum(PLAN_IDS),
});

/** Manually assigns a plan to a user. POST, admin-only, validated and audit-logged. */
export const setUserPlanFn = createServerFn({ method: "POST" })
  .inputValidator(planInput)
  .handler(async ({ data }) => {
    const admin = await requireAdmin();
    const result = await setUserPlan(getAdminSql(), {
      userId: data.userId,
      plan: data.plan,
      adminId: admin.userId,
    });
    console.info("[admin] plan changed", {
      by: admin.userId,
      userId: result.userId,
      plan: result.plan,
    });
    return result;
  });
