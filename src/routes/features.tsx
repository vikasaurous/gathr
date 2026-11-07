import { createFileRoute } from "@tanstack/react-router";
import { PageIntro, SiteFooter, SiteHeader } from "@/components/gathr/site-chrome";
import { FEATURES } from "@/components/gathr/features-list";

export const Route = createFileRoute("/features")({
  head: () => ({
    meta: [
      { title: "Features — gathr" },
      { name: "description", content: "Bulk PDF processing, invoice separation, GST extraction, duplicate detection and structured exports." },
      { property: "og:title", content: "Features — gathr" },
      { property: "og:description", content: "Bulk PDF processing, invoice separation, GST extraction, duplicate detection and structured exports." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Features,
});

function Features() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <PageIntro eyebrow="Features" title={<>Small details. <em>Less manual work.</em></>} />
      <section className="mx-auto max-w-[1240px] px-6 pb-28">
        <ul className="grid border-t border-foreground md:grid-cols-2">
          {FEATURES.map(([Icon, t, d], i) => (
            <li key={t} className={`flex gap-6 border-b border-border py-10 ${i % 2 ? "md:border-l md:pl-10" : "md:pr-10"}`}>
              <span className="num w-6 text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <Icon className="size-4 text-primary" strokeWidth={1.5} />
                <h2 className="mt-4 font-serif text-[30px] leading-tight">{t}</h2>
                <p className="mt-2 max-w-sm text-muted-foreground">{d}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <SiteFooter />
    </div>
  );
}
