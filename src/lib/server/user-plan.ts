import { DEFAULT_PLAN, isPlanId, type PlanId } from "@/lib/gathr/plans";

/** Minimal SQL interface (matches neon().query) so this is unit-testable. */
export interface PlanSql {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Returns the user's plan. A user without a user_plan row, or with an
 * unrecognised value, is on the default (Free) plan.
 */
export async function fetchUserPlan(sql: PlanSql, userId: string): Promise<PlanId> {
  const rows = await sql.query(`SELECT "plan" FROM "user_plan" WHERE "userId" = $1::text LIMIT 1`, [
    userId,
  ]);
  const plan = rows[0]?.["plan"];
  return isPlanId(plan) ? plan : DEFAULT_PLAN;
}
