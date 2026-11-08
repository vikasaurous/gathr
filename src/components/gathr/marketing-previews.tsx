import { Check, FileStack, Search } from "lucide-react";
import { formatMoney } from "@/lib/gathr/format";
import { buildDemoState } from "@/lib/gathr/demo-data";
import { Mark } from "./brand";
import { DocumentPage } from "./document-page";
import { InvoiceStatusPill, SourceTag } from "./status";
import { FIELD_META } from "@/lib/gathr/types";

const demo = buildDemoState();
const batch = demo.batches[0]!;
const invs = demo.invoices.filter((i) => i.batchId === batch.id);

/** Static product composition built from the same components/data as the app. */
export function HeroPreview() {
  const verified = invs.filter((i) => i.status === "verified").length;
  return (
    <div className="relative">
      <div className="absolute -left-6 top-10 hidden h-[86%] w-[78%] rotate-[-3deg] rounded-lg border border-border bg-paper lg:block" />
      <div className="relative overflow-hidden rounded-lg border border-border bg-surface shadow-sheet">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-[12px]">
            <Mark className="size-3.5" />
            <span className="text-muted-foreground">Batches /</span>
            <span>{batch.name}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
            <Search className="size-3" /> Search
          </div>
        </div>
        <div className="grid grid-cols-4 border-b border-border">
          {[
            ["Pages", batch.files[0]!.pageCount],
            ["Invoices", invs.length],
            ["Verified", verified],
            ["Review", invs.length - verified],
          ].map(([l, v], i) => (
            <div key={l} className={i ? "border-l border-border px-4 py-3" : "px-4 py-3"}>
              <p className="text-[10.5px] text-muted-foreground">{l}</p>
              <p className="mt-1 font-serif text-[28px] leading-none">{v}</p>
            </div>
          ))}
        </div>
        <div className="px-4 py-2">
          <div className="grid grid-cols-[1.6fr_1fr_1fr_auto] gap-3 border-b border-border py-2 text-[10.5px] uppercase tracking-wider text-muted-foreground">
            <span>Supplier</span>
            <span>Invoice</span>
            <span className="text-right">Total</span>
            <span className="w-20">Status</span>
          </div>
          {invs.slice(0, 7).map((i) => (
            <div key={i.id} className="grid grid-cols-[1.6fr_1fr_1fr_auto] items-center gap-3 border-b border-border/70 py-2 text-[12px] last:border-0">
              <span className="truncate">{i.fields.supplier.value}</span>
              <span className="num truncate text-[11px] text-muted-foreground">{i.fields.invoiceNumber.value}</span>
              <span className="num text-right text-[11px]">{formatMoney(i.fields.total.value)}</span>
              <span className="w-20">
                <InvoiceStatusPill status={i.status} />
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute -bottom-6 -right-3 hidden w-56 rounded-lg border border-border bg-surface p-3 shadow-sheet md:block">
        <div className="flex items-center gap-2 text-[12px]">
          <FileStack className="size-3.5 text-primary" />
          october_vendor_bills_combined.pdf
        </div>
        <div className="mt-2.5 flex gap-[2px]">
          {invs.map((i) => (
            <span key={i.id} className="h-5 rounded-[2px] bg-primary/15" style={{ flex: i.pages.length }} />
          ))}
        </div>
        <p className="num mt-2 text-[10.5px] text-muted-foreground">{invs.length} invoices detected across {batch.files[0]!.pageCount} pages</p>
      </div>
    </div>
  );
}

export function ReviewShowcase() {
  const inv = invs[3]!; // has an invalid GSTIN in demo data
  return (
    <div className="grid overflow-hidden rounded-lg border border-border bg-surface shadow-sheet md:grid-cols-[1.1fr_1fr]">
      <div className="border-b border-border bg-secondary p-6 md:border-b-0 md:border-r md:p-10">
        <div className="mx-auto max-w-[420px]">
          <DocumentPage invoice={inv} page={inv.pages[0]!} highlight="gstin" />
          <p className="num mt-3 text-center text-[11px] text-muted-foreground">
            Source · page {inv.pages.join("–")} of {batch.files[0]!.pageCount}
          </p>
        </div>
      </div>
      <div className="p-6 md:p-8">
        <div className="flex items-center justify-between">
          <p className="num text-[11px] text-muted-foreground">INVOICE 04 / {invs.length}</p>
          <InvoiceStatusPill status="needs_review" />
        </div>
        <div className="mt-5 divide-y divide-border border-y border-border">
          {FIELD_META.filter((m) => ["supplier", "gstin", "invoiceNumber", "invoiceDate", "taxableValue", "total"].includes(m.key)).map((m) => {
            const fv = inv.fields[m.key];
            const bad = m.key === "gstin";
            return (
              <div key={m.key} className="grid grid-cols-[110px_1fr] items-center gap-3 py-2.5">
                <span className="text-[12px] text-muted-foreground">{m.label}</span>
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-[13px] ${m.kind !== "text" ? "num" : ""} ${bad ? "text-destructive" : ""}`}>
                    {m.kind === "money" ? formatMoney(fv.value) : fv.value}
                  </span>
                  <SourceTag source={fv.source} confidence={fv.confidence} />
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-4 rounded-md bg-destructive/8 px-3 py-2 text-[12px] text-destructive">GSTIN does not match the 15-character format.</p>
        <div className="mt-5 flex gap-2">
          <span className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-primary text-[13px] text-primary-foreground">
            <Check className="size-4" /> Approve invoice
          </span>
          <span className="inline-flex h-9 items-center rounded-md border border-border px-3 text-[13px]">Skip</span>
        </div>
      </div>
    </div>
  );
}
