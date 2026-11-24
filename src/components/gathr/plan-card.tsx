import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PLANS } from "@/lib/gathr/marketing-content";
import { NEXT_PLAN, PLAN_LABELS, type PlanId } from "@/lib/gathr/plans";

/** Settings card: current plan, price, allowance, inclusions and the upgrade path. */
export function PlanCard({ plan }: { plan: PlanId }) {
  const details = PLANS.find((p) => p.name.toLowerCase() === plan);
  const next = NEXT_PLAN[plan];

  return (
    <div className="max-w-md rounded-md border border-border bg-surface">
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Current plan</p>
          <p className="mt-1.5 font-serif text-[28px] leading-none">{PLAN_LABELS[plan]}</p>
          {details && <p className="mt-2 text-[12.5px] text-muted-foreground">{details.note}</p>}
        </div>
        {next && (
          <Button asChild size="sm" variant="ink" className="shrink-0">
            <Link to="/pricing">
              Upgrade to {PLAN_LABELS[next]}
              <ArrowUpRight />
            </Link>
          </Button>
        )}
      </div>

      {details && (
        <>
          <dl className="grid grid-cols-2 border-t border-border">
            <div className="px-4 py-3">
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Price</dt>
              <dd className="num mt-1 text-[13px]">
                {details.price} <span className="text-muted-foreground">{details.period}</span>
              </dd>
            </div>
            <div className="border-l border-border px-4 py-3">
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Allowance
              </dt>
              <dd className="num mt-1 text-[13px]">{details.allowance}</dd>
            </div>
          </dl>

          <ul className="space-y-2 border-t border-border px-4 py-3.5">
            {details.items.map((item) => (
              <li key={item} className="flex items-start gap-2 text-[12.5px]">
                <Check className="mt-0.5 size-3.5 shrink-0 text-primary" strokeWidth={2} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="border-t border-border px-4 py-3 text-[12px] text-muted-foreground">
        {next ? "Plan changes are handled by our team for now." : "You're on our highest plan."}{" "}
        <a
          href="mailto:hello@gathr.example"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Contact us
        </a>{" "}
        {next ? "to switch plans." : "to adjust it."}
      </p>
    </div>
  );
}
