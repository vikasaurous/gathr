import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { DEFAULT_PLAN, type PlanId } from "@/lib/gathr/plans";
import { resolveSession } from "@/lib/server/auth-session";
import { getSql } from "@/lib/server/sql";
import { fetchUserPlan } from "@/lib/server/user-plan";

/**
 * Returns the signed-in user's own plan. Always scoped to the session user
 * (no user id is accepted from the client), and fails soft to Free so a plan
 * lookup problem can never break the workspace.
 */
export const getMyPlanFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ plan: PlanId }> => {
    try {
      const session = await resolveSession();
      const userId = session?.user?.id;
      if (!userId) return { plan: DEFAULT_PLAN };
      const plan = await fetchUserPlan(getSql(), userId);
      setResponseHeader("Cache-Control", "private, no-store");
      return { plan };
    } catch (err) {
      console.error("[getMyPlanFn] failed, falling back to free:", err);
      return { plan: DEFAULT_PLAN };
    }
  },
);
