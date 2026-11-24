import { neon } from "@neondatabase/serverless";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { auth } from "@/lib/auth/server";
import { DEFAULT_PLAN, type PlanId } from "@/lib/gathr/plans";
import { getServerEnv } from "@/lib/server/env";
import { fetchUserPlan } from "@/lib/server/user-plan";

/**
 * Returns the signed-in user's own plan. Always scoped to the session user
 * (no user id is accepted from the client), and fails soft to Free so a plan
 * lookup problem can never break the workspace.
 */
export const getMyPlanFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ plan: PlanId }> => {
    try {
      const session = await auth.api.getSession({ headers: getRequestHeaders() });
      const userId = session?.user?.id;
      const url = getServerEnv().DATABASE_URL;
      if (!userId || !url) return { plan: DEFAULT_PLAN };
      const sql = neon(url);
      const plan = await fetchUserPlan(
        {
          query: (text, params) =>
            sql.query(text, params ?? []) as Promise<Record<string, unknown>[]>,
        },
        userId,
      );
      setResponseHeader("Cache-Control", "private, no-store");
      return { plan };
    } catch (err) {
      console.error("[getMyPlanFn] failed, falling back to free:", err);
      return { plan: DEFAULT_PLAN };
    }
  },
);
