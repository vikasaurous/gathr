import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/gathr/brand";
import { HeroPreview, ReviewShowcase } from "@/components/gathr/marketing-previews";
import { PageIntro, SiteFooter, SiteHeader } from "@/components/gathr/site-chrome";

export const Route = createFileRoute("/product")({
  head: () => ({
    meta: [
      { title: "Product — gathr invoice processing workspace" },
      {
        name: "description",
        content:
          "gathr turns unorganized invoice documents into structured, reviewable financial records.",
      },
      { property: "og:title", content: "Product — gathr invoice processing workspace" },
      {
        property: "og:description",
        content:
          "gathr turns unorganized invoice documents into structured, reviewable financial records.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Product,
});

function Product() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <PageIntro
        eyebrow="Product"
        title={
          <>
            Not a converter. <em>A workspace.</em>
          </>
        }
      >
        gathr turns unorganized invoice documents into structured, reviewable financial records —
        with every value traceable to its source page.
      </PageIntro>
      <section className="mx-auto max-w-[1240px] px-6 pb-24">
        <HeroPreview />
      </section>
      <section className="mx-auto max-w-[1240px] px-6 py-20">
        <SectionLabel n="01">What you receive</SectionLabel>
        <div className="mt-12 grid gap-x-12 gap-y-8 md:grid-cols-3">
          {[
            [
              "Combined PDFs",
              "Month-end bundles from vendors or clients, dozens of invoices in one file.",
            ],
            ["Scans and photos", "Inconsistent layouts, skewed pages, uneven quality."],
            ["Duplicates", "The same invoice, sent twice, by email and by courier."],
          ].map(([t, d]) => (
            <div key={t} className="border-t border-border pt-6">
              <h3 className="font-serif text-[28px]">{t}</h3>
              <p className="mt-2 text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="mx-auto max-w-[1240px] px-6 pb-28">
        <SectionLabel n="02">What you keep</SectionLabel>
        <div className="mt-12">
          <ReviewShowcase />
        </div>
        <div className="mt-12 text-center">
          <Button variant="ink" size="lg" asChild>
            <Link to="/app">Open the workspace</Link>
          </Button>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
