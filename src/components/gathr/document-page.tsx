import { formatDate, formatMoney } from "@/lib/gathr/format";
import type { Invoice } from "@/lib/gathr/types";
import { cn } from "@/lib/utils";

/**
 * Synthetic rendering of an invoice page from demo data. A real PDF renderer
 * (e.g. pdf.js) would replace this when file storage is connected.
 */
export function DocumentPage({
  invoice,
  page,
  highlight,
  className,
}: {
  invoice: Invoice;
  page: number;
  highlight?: string | null;
  className?: string;
}) {
  const f = invoice.fields;
  const first = page === invoice.pages[0];
  const hl = (k: string) => cn("rounded-[2px] transition-colors", highlight === k && "bg-warning/25 outline outline-1 outline-warning");
  const taxable = Number(f.taxableValue.value) || 0;
  const lines = [0.42, 0.33, 0.25].map((r, i) => ({ d: ["Professional services", "Materials & supplies", "Delivery and handling"][i], a: taxable * r }));
  return (
    <div className={cn("aspect-[1/1.414] w-full bg-surface p-[7%] text-[clamp(6px,1.05cqw,11px)] text-foreground shadow-sheet [container-type:inline-size]", className)}>
      {first ? (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between">
            <div>
              <p className={cn("font-serif text-[2.4em] leading-none", hl("supplier"))}>{f.supplier.value || "—"}</p>
              <p className={cn("num mt-[0.8em] text-muted-foreground", hl("gstin"))}>GSTIN {f.gstin.value || "—"}</p>
            </div>
            <p className="num text-[1.1em] uppercase tracking-[0.2em] text-muted-foreground">Tax invoice</p>
          </div>
          <div className="mt-[8%] grid grid-cols-3 gap-[4%] border-y border-border py-[3%]">
            {[
              ["Invoice no.", f.invoiceNumber.value, "invoiceNumber"],
              ["Date", formatDate(f.invoiceDate.value), "invoiceDate"],
              ["Due", formatDate(f.dueDate.value), "dueDate"],
            ].map(([l, v, k]) => (
              <div key={k}>
                <p className="text-[0.85em] uppercase tracking-wider text-muted-foreground">{l}</p>
                <p className={cn("num mt-[0.3em]", hl(k ?? ""), !v && "text-destructive")}>{v || "not found"}</p>
              </div>
            ))}
          </div>
          <div className="mt-[6%] space-y-[0.9em]">
            {lines.map((l) => (
              <div key={l.d} className="flex justify-between border-b border-border/70 pb-[0.6em]">
                <span>{l.d}</span>
                <span className="num">{formatMoney(l.a)}</span>
              </div>
            ))}
          </div>
          <div className="ml-auto mt-auto w-[55%] space-y-[0.5em]">
            {[
              ["Taxable value", f.taxableValue.value, "taxableValue"],
              ["CGST", f.cgst.value, "cgst"],
              ["SGST", f.sgst.value, "sgst"],
              ["IGST", f.igst.value, "igst"],
            ].map(([l, v, k]) => (
              <div key={k} className="flex justify-between text-muted-foreground">
                <span>{l}</span>
                <span className={cn("num", hl(k ?? ""))}>{formatMoney(v ?? "")}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-foreground pt-[0.6em] text-[1.3em]">
              <span>Total</span>
              <span className={cn("num", hl("total"))}>{formatMoney(f.total.value)}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <p className="num text-muted-foreground">
            {f.supplier.value} · {f.invoiceNumber.value} · continued
          </p>
          <div className="mt-[8%] space-y-[1.2em]">
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className="h-[0.55em] rounded-full bg-secondary" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
            ))}
          </div>
          <p className="mt-auto text-muted-foreground">Terms & bank details</p>
        </div>
      )}
    </div>
  );
}
