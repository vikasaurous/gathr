import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { NEXT_PLAN, PLAN_LABELS, type PlanId } from "@/lib/gathr/plans";
import { cn } from "@/lib/utils";

const BADGE_TONE: Record<PlanId, string> = {
  free: "border-border text-muted-foreground",
  pro: "border-primary/30 bg-primary/10 text-primary",
  business: "border-primary/30 bg-primary/10 text-primary",
};

/** Compact plan tag: neutral outline for Free, accent for paid plans. */
export function PlanBadge({ plan }: { plan: PlanId }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10.5px] font-medium uppercase leading-none tracking-wider",
        BADGE_TONE[plan],
      )}
    >
      {PLAN_LABELS[plan]}
    </span>
  );
}

/**
 * Sidebar row showing the current plan with a clear next action:
 * "Upgrade" (to the pricing page) while a higher plan exists, otherwise "Manage".
 */
export function SidebarPlanLink({ plan }: { plan: PlanId }) {
  const canUpgrade = NEXT_PLAN[plan] !== null;
  return (
    <Link
      to={canUpgrade ? "/pricing" : "/app/settings"}
      className="flex items-center justify-between rounded-md px-2.5 py-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
    >
      <span className="flex items-center gap-2">
        Plan <PlanBadge plan={plan} />
      </span>
      <span className={cn("inline-flex items-center gap-0.5", canUpgrade && "text-primary")}>
        {canUpgrade ? "Upgrade" : "Manage"}
        <ArrowUpRight className="size-3.5" strokeWidth={1.6} />
      </span>
    </Link>
  );
}
