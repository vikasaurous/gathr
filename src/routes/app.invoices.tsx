import { createFileRoute, Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, FilterTabs, PageHeader } from "@/components/gathr/common";
import { ExportDialog } from "@/components/gathr/export-dialog";
import { InvoiceStatusPill, SourceTag } from "@/components/gathr/status";
import { formatDate, formatMoney, pageRange } from "@/lib/gathr/format";
import { useWorkspace } from "@/lib/gathr/store";
import { FIELD_META, type Invoice, type InvoiceStatus } from "@/lib/gathr/types";
import { validateInvoice } from "@/lib/gathr/validation";

export const Route = createFileRoute("/app/invoices")({
  head: () => ({
    meta: [
      { title: "Invoices — gathr" },
      { name: "description", content: "Search every processed invoice in your workspace." },
      { property: "og:title", content: "Invoices — gathr" },
      { property: "og:description", content: "Search every processed invoice in your workspace." },
    ],
  }),
  component: Invoices,
});

type F = "all" | InvoiceStatus | "missing";

function Invoices() {
  const ws = useWorkspace();
  const [status, setStatus] = useState<F>("all");
  const [q, setQ] = useState("");
  const [supplier, setSupplier] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState<Invoice | null>(null);
  const suppliers = [
    ...new Set(ws.invoices.map((i) => i.fields.supplier.value).filter(Boolean)),
  ].sort();
  const missing = (i: Invoice) =>
    Object.values(i.fields).some((f) => f.source === "missing" || !f.value);
  const rows = useMemo(
    () =>
      ws.invoices
        .filter((i) => {
          const f = i.fields;
          if (status === "missing" ? !missing(i) : status !== "all" && i.status !== status)
            return false;
          if (supplier !== "all" && f.supplier.value !== supplier) return false;
          if (from && f.invoiceDate.value < from) return false;
          if (to && f.invoiceDate.value > to) return false;
          return [f.supplier.value, f.invoiceNumber.value, f.gstin.value, i.fileName]
            .join(" ")
            .toLowerCase()
            .includes(q.toLowerCase());
        })
        .sort((a, b) => b.fields.invoiceDate.value.localeCompare(a.fields.invoiceDate.value)),
    [ws.invoices, status, q, supplier, from, to],
  );
  const c = (s: F) =>
    ws.invoices.filter((i) => (s === "all" ? true : s === "missing" ? missing(i) : i.status === s))
      .length;
  const filtered = q || supplier !== "all" || from || to || status !== "all";
  const batchName = (id: string) => ws.batches.find((b) => b.id === id)?.name ?? id;

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-8 md:px-10 md:py-12">
      <PageHeader
        eyebrow="Library"
        title="Invoices"
        actions={<ExportDialog invoices={rows} label={`${rows.length} filtered invoices`} />}
      >
        Every invoice gathered, across all batches.
      </PageHeader>
      <div className="space-y-3 py-5">
        <FilterTabs
          value={status}
          onChange={setStatus}
          options={(
            ["all", "needs_review", "verified", "duplicate", "skipped", "missing"] as F[]
          ).map((v) => ({
            value: v,
            label: {
              all: "All",
              needs_review: "Needs review",
              verified: "Verified",
              duplicate: "Duplicates",
              skipped: "Skipped",
              missing: "Missing info",
            }[v],
            count: c(v),
          }))}
        />
        <div className="grid gap-2 md:grid-cols-[1fr_220px_150px_150px_auto]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Supplier, invoice number, GSTIN"
              className="bg-surface pl-9"
            />
          </div>
          <Select value={supplier} onValueChange={setSupplier}>
            <SelectTrigger className="bg-surface">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suppliers</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="num bg-surface text-[12px]"
            aria-label="From date"
          />
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="num bg-surface text-[12px]"
            aria-label="To date"
          />
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setQ("");
                setSupplier("all");
                setFrom("");
                setTo("");
                setStatus("all");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title="No invoices match."
          action={
            <Button variant="outline" asChild>
              <Link to="/app/new">Upload documents</Link>
            </Button>
          }
        >
          Adjust the filters, or bring in a new batch.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-[13.5px]">
            <thead>
              <tr className="border-y border-foreground text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2.5 font-normal">Supplier</th>
                <th className="font-normal">Invoice no.</th>
                <th className="font-normal">Date</th>
                <th className="text-right font-normal">Total</th>
                <th className="pl-6 font-normal">GSTIN</th>
                <th className="font-normal">Status</th>
                <th className="font-normal">Batch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const iss = validateInvoice(i, ws.invoices).length;
                return (
                  <tr
                    key={i.id}
                    onClick={() => setOpen(i)}
                    className="cursor-pointer border-b border-border transition-colors hover:bg-surface"
                  >
                    <td className="py-3">
                      {i.fields.supplier.value || <span className="text-destructive">Missing</span>}
                      {iss > 0 && i.status === "needs_review" && (
                        <span className="num ml-2 text-[10.5px] text-warning">
                          {iss} issue{iss > 1 ? "s" : ""}
                        </span>
                      )}
                    </td>
                    <td className="num text-[12px]">
                      {i.fields.invoiceNumber.value || <span className="text-destructive">—</span>}
                    </td>
                    <td className="num text-[12px] text-muted-foreground">
                      {formatDate(i.fields.invoiceDate.value)}
                    </td>
                    <td className="num text-right text-[12.5px]">
                      {formatMoney(i.fields.total.value)}
                    </td>
                    <td className="num pl-6 text-[11.5px] text-muted-foreground">
                      {i.fields.gstin.value}
                    </td>
                    <td>
                      <InvoiceStatusPill status={i.status} />
                    </td>
                    <td className="num max-w-[160px] truncate text-[11.5px] text-muted-foreground">
                      {i.batchId}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {open && (
            <>
              <SheetHeader>
                <p className="num text-[11px] text-muted-foreground">{open.fileName}</p>
                <SheetTitle className="font-serif text-[30px] font-normal leading-tight">
                  {open.fields.supplier.value || "Unknown supplier"}
                </SheetTitle>
                <div>
                  <InvoiceStatusPill status={open.status} />
                </div>
              </SheetHeader>
              <dl className="mt-6 divide-y divide-border border-y border-border px-4">
                {FIELD_META.map((m) => (
                  <div key={m.key} className="flex items-center justify-between gap-3 py-2.5">
                    <dt className="text-[12.5px] text-muted-foreground">{m.label}</dt>
                    <dd className="flex flex-col items-end gap-0.5 text-right">
                      <span className={m.kind === "text" ? "text-[13.5px]" : "num text-[12.5px]"}>
                        {m.kind === "money"
                          ? formatMoney(open.fields[m.key].value)
                          : m.kind === "date"
                            ? formatDate(open.fields[m.key].value)
                            : open.fields[m.key].value || "—"}
                      </span>
                      <SourceTag
                        source={open.fields[m.key].source}
                        confidence={open.fields[m.key].confidence}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="num mt-4 px-4 text-[11px] text-muted-foreground">
                {open.sourceFile} · {pageRange(open.pages)} · {batchName(open.batchId)}
              </p>
              <div className="px-4 pt-6">
                <Button variant="ink" className="w-full" asChild>
                  <Link
                    to="/app/batches/$id"
                    params={{ id: open.batchId }}
                    search={{ invoice: open.id }}
                  >
                    Open in review workspace
                  </Link>
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
