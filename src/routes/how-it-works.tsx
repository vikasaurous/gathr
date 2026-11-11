import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PageIntro, SiteFooter, SiteHeader } from "@/components/gathr/site-chrome";

export const Route = createFileRoute("/how-it-works")({
  head: () => ({
    meta: [
      { title: "How it works — gathr" },
      {
        name: "description",
        content: "Upload, detect, extract, review, deduplicate, organize and export invoices.",
      },
      { property: "og:title", content: "How it works — gathr" },
      {
        property: "og:description",
        content: "Upload, detect, extract, review, deduplicate, organize and export invoices.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HowItWorks,
});

const FLOW = [
  [
    "Upload documents",
    "Drop a 200-page combined PDF, or forty individual invoices. Both are welcome.",
  ],
  [
    "Detect individual invoices",
    "gathr finds where each invoice begins and ends. Multi-page invoices stay together; separate invoices are never silently merged.",
  ],
  [
    "Extract financial information",
    "Supplier, GSTIN, invoice number, dates, taxable value, CGST, SGST, IGST and totals — each with a confidence indicator.",
  ],
  [
    "Review uncertain fields",
    "Low-confidence values are marked unverified. Corrections are recorded alongside the original value.",
  ],
  [
    "Identify duplicates and inconsistencies",
    "Repeated invoice numbers, malformed GSTINs and totals that don't add up are flagged — never auto-corrected.",
  ],
  [
    "Organize documents",
    "Each invoice is renamed from a template you control and filed under its batch.",
  ],
  ["Export records", "CSV and Excel-ready workbooks, individual PDFs or a combined archive."],
];

function HowItWorks() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <PageIntro
        eyebrow="How it works"
        title={
          <>
            Seven steps, <em>one workspace.</em>
          </>
        }
      >
        What happens between receiving an invoice and having it ready for your records.
      </PageIntro>
      <section className="mx-auto max-w-[1240px] px-6 pb-24">
        <ol className="border-t border-foreground">
          {FLOW.map(([t, d], i) => (
            <li key={t} className="grid gap-4 border-b border-border py-10 md:grid-cols-12">
              <span className="num text-xs text-muted-foreground md:col-span-2">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h2 className="font-serif text-[34px] leading-tight md:col-span-5">{t}</h2>
              <p className="max-w-md text-muted-foreground md:col-span-5">{d}</p>
            </li>
          ))}
        </ol>
        <div className="mt-16 flex flex-wrap items-center justify-between gap-6">
          <p className="font-serif text-3xl">Try it with demonstration data.</p>
          <Button variant="ink" size="lg" asChild>
            <Link to="/app/new">Start a batch</Link>
          </Button>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
