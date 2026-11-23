/** Plan identifiers stored in the database. Display copy/prices live in marketing-content.ts. */
export const PLAN_IDS = ["free", "pro", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const DEFAULT_PLAN: PlanId = "free";

export const PLAN_LABELS: Record<PlanId, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
};

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

/** The next tier up, used for upgrade prompts. Business is the top tier. */
export const NEXT_PLAN: Record<PlanId, PlanId | null> = {
  free: "pro",
  pro: "business",
  business: null,
};
