// at the top with the other imports
import { GoogleOneTapPrompt } from "@/components/gathr/google-one-tap";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { FEATURES, STEPS } from "@/components/gathr/features-list";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/gathr/brand";
import { HeroPreview, ReviewShowcase } from "@/components/gathr/marketing-previews";
import { SiteFooter, SiteHeader } from "@/components/gathr/site-chrome";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "gathr | Paperwork, brought into order" },
      {
        name: "description",
        content:
          "Turn scattered invoices and combined PDFs into clean, organized financial records.",
      },
      { property: "og:title", content: "gathr — Paperwork, brought into order" },
      {
        property: "og:description",
        content:
          "Turn scattered invoices and combined PDFs into clean, organized financial records.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <div className="min-h-screen">
      <GoogleOneTapPrompt />
      <SiteHeader />
      <main>
        {/* Hero */}
        <section className="mx-auto grid max-w-[1240px] gap-16 px-6 pb-24 pt-16 md:pt-24 lg:grid-cols-12 lg:gap-10">
          <div className="animate-rise lg:col-span-5 lg:pt-8">
            <p className="eyebrow">Document processing, refined</p>
            <h1 className="display mt-7 text-[64px] sm:text-[84px] xl:text-[104px]">
              Paperwork,
              <br />
              <em className="text-primary">brought</em> into
              <br />
              order.
            </h1>
            <p className="mt-8 max-w-md text-[17px] leading-relaxed text-muted-foreground">
              Turn scattered invoices and combined PDFs into clean, organized financial records.
              Less sorting. Less manual work. More clarity.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button size="lg" variant="ink" asChild>
                <Link to="/app/new">
                  Get started <ArrowRight />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/how-it-works">Explore the workflow</Link>
              </Button>
            </div>
            <p className="mt-10 border-t border-border pt-5 text-[13px] text-muted-foreground">
              Built for accountants, bookkeepers and modern businesses.
            </p>
          </div>
          <div className="animate-rise [animation-delay:150ms] lg:col-span-7">
            <HeroPreview />
          </div>
        </section>

        {/* Workflow */}
        <section className="mx-auto max-w-[1240px] px-6 py-24">
          <SectionLabel n="01">The workflow</SectionLabel>
          <div className="mt-14 grid gap-10 lg:grid-cols-12">
            <h2 className="display text-[48px] md:text-[64px] lg:col-span-6">
              From documents
              <br />
              to <em>decisions.</em>
            </h2>
            <p className="max-w-sm self-end text-muted-foreground lg:col-span-4 lg:col-start-9">
              Everything that happens between receiving an invoice and having it ready for your
              records.
            </p>
          </div>
          <div className="mt-16 grid border-t border-foreground md:grid-cols-3">
            {STEPS.map(([n, t, d], i) => (
              <div
                key={n}
                className={`py-10 md:px-8 ${i ? "border-t border-border md:border-l md:border-t-0" : "md:pl-0"}`}
              >
                <span className="num text-xs text-muted-foreground">{n}</span>
                <h3 className="mt-10 font-serif text-[40px] leading-none">{t}</h3>
                <p className="mt-4 max-w-xs text-[15px] leading-relaxed text-muted-foreground">
                  {d}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section className="border-y border-border bg-secondary">
          <div className="mx-auto max-w-[1240px] px-6 py-24">
            <SectionLabel n="02">Features</SectionLabel>
            <div className="mt-14 grid gap-16 lg:grid-cols-12">
              <div className="lg:col-span-4">
                <h2 className="display text-[48px] md:text-[60px]">
                  Small details.
                  <br />
                  <em>Less manual work.</em>
                </h2>
                <div className="mt-10 rounded-lg border border-border bg-surface p-4">
                  <p className="eyebrow">Filename preview</p>
                  <p className="num mt-3 text-[12.5px]">Northfield_NOR-26-482_2026-10-21.pdf</p>
                  <p className="num mt-1 text-[12.5px]">Kavya_KAV-26-117_2026-10-24.pdf</p>
                  <p className="num mt-1 text-[12.5px] text-muted-foreground line-through">
                    Kavya_KAV-26-117_2026-10-24.pdf
                  </p>
                  <p className="mt-2 text-[11.5px] text-destructive">
                    Duplicate candidate · excluded
                  </p>
                </div>
              </div>
              <ul className="grid gap-x-10 sm:grid-cols-2 lg:col-span-8">
                {FEATURES.map(([Icon, t, d]) => (
                  <li key={t} className="flex gap-4 border-b border-border py-5">
                    <Icon className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.5} />
                    <div>
                      <p className="text-[15px]">{t}</p>
                      <p className="mt-1 text-[13.5px] text-muted-foreground">{d}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Showcase */}
        <section className="mx-auto max-w-[1240px] px-6 py-24">
          <SectionLabel n="03">Review</SectionLabel>
          <div className="mt-14 grid gap-10 lg:grid-cols-12">
            <h2 className="display text-[48px] md:text-[64px] lg:col-span-7">
              Information should be <em>easy to trust.</em>
            </h2>
            <p className="max-w-sm self-end text-muted-foreground lg:col-span-4 lg:col-start-9">
              See where every detail came from. Review uncertain information. Keep your records
              accurate.
            </p>
          </div>
          <div className="mt-14">
            <ReviewShowcase />
          </div>
        </section>

        {/* Privacy */}
        <section className="bg-ink text-ink-foreground">
          <div className="mx-auto grid max-w-[1240px] gap-12 px-6 py-28 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <p className="eyebrow text-ink-muted">04 / Privacy</p>
              <h2 className="display mt-8 text-[56px] md:text-[80px]">
                Your documents
                <br />
                <em>deserve care.</em>
              </h2>
            </div>
            <div className="self-end lg:col-span-4 lg:col-start-9">
              <ShieldCheck className="size-5 text-ink-muted" strokeWidth={1.5} />
              <p className="mt-5 leading-relaxed text-ink-muted">
                Financial documents contain sensitive information. gathr is designed around
                responsible document handling, controlled access and transparent processing.
              </p>
              <ul className="mt-8 space-y-3 border-t border-ink-border pt-6 text-sm">
                <li>Original files and source pages are preserved.</li>
                <li>Every correction is recorded.</li>
                <li>Nothing is approved without a person.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-[1240px] px-6 py-32 text-center">
          <h2 className="display text-[56px] md:text-[96px]">
            Make room for
            <br />
            <em>better work.</em>
          </h2>
          <p className="mx-auto mt-6 max-w-md text-muted-foreground">
            Bring your invoice workflow together with gathr.
          </p>
          <Button size="lg" variant="ink" className="mt-10" asChild>
            <Link to="/app/new">
              Get started <ArrowRight />
            </Link>
          </Button>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
