import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PageIntro, SiteFooter, SiteHeader } from "@/components/gathr/site-chrome";
import { PLANS } from "@/lib/gathr/marketing-content";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — gathr" },
      {
        name: "description",
        content: "Simple plans for invoice processing: Free, Pro and Business.",
      },
      { property: "og:title", content: "Pricing — gathr" },
      {
        property: "og:description",
        content: "Simple plans for invoice processing: Free, Pro and Business.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Pricing,
});

function Pricing() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <PageIntro
        eyebrow="Pricing"
        title={
          <>
            Priced for the <em>work you do.</em>
          </>
        }
      >
        Start free. Move up when your volume does. Prices shown are placeholders for this prototype.
      </PageIntro>
      <section className="mx-auto max-w-[1240px] px-6 pb-28">
        <div className="grid border-t border-foreground md:grid-cols-3">
          {PLANS.map((p, i) => (
            <div
              key={p.name}
              className={cn(
                "flex flex-col py-10 md:px-8",
                i && "border-t border-border md:border-l md:border-t-0",
                i === 0 && "md:pl-0",
                p.featured && "bg-surface md:px-8",
              )}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="font-serif text-[36px]">{p.name}</h2>
                {p.featured && <span className="eyebrow text-primary">Most chosen</span>}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{p.note}</p>
              <p className="mt-10 font-serif text-[64px] leading-none">{p.price}</p>
              <p className="num mt-2 text-xs text-muted-foreground">
                {p.period} · {p.allowance}
              </p>
              <ul className="mt-10 flex-1 space-y-3 border-t border-border pt-6 text-[14px]">
                {p.items.map((it) => (
                  <li key={it} className="flex gap-3">
                    <span className="mt-2 h-px w-3 shrink-0 bg-foreground" />
                    {it}
                  </li>
                ))}
              </ul>
              <Button variant={p.featured ? "default" : "outline"} className="mt-10" asChild>
                <Link to="/app/new">Start with {p.name}</Link>
              </Button>
            </div>
          ))}
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
