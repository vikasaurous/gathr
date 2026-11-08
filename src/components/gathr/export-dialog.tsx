import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { buildFileName, downloadText, invoicesToCsv } from "@/lib/gathr/export";
import { actions, useWorkspace } from "@/lib/gathr/store";
import type { Invoice } from "@/lib/gathr/types";
import { cn } from "@/lib/utils";

const FORMATS = [
  { key: "csv", label: "CSV", note: "Downloads now", works: true },
  { key: "xlsx", label: "Excel workbook", note: "Simulated", works: false },
  { key: "pdf", label: "Individual PDFs", note: "Simulated", works: false },
  { key: "zip", label: "Combined ZIP", note: "Simulated", works: false },
] as const;

export function ExportDialog({ invoices, trigger, label }: { invoices: Invoice[]; trigger?: React.ReactNode; label: string }) {
  const ws = useWorkspace();
  const [format, setFormat] = useState<(typeof FORMATS)[number]["key"]>("csv");
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [includeReview, setIncludeReview] = useState(false);
  const [excludeDup, setExcludeDup] = useState(true);
  const selected = invoices.filter((i) => {
    if (excludeDup && i.status === "duplicate") return false;
    if (i.status === "verified") return true;
    if (i.status === "needs_review") return includeReview;
    return !verifiedOnly && i.status !== "duplicate" ? true : !excludeDup && i.status === "duplicate";
  });
  const f = FORMATS.find((x) => x.key === format)!;
  const sample = selected[0] ?? invoices[0];

  function run() {
    if (!selected.length) return toast.error("No invoices match these options.");
    if (f.works) {
      downloadText(`gathr_${label.replace(/\W+/g, "-").toLowerCase()}.csv`, invoicesToCsv(selected));
      toast.success(`CSV with ${selected.length} demo records downloaded`);
    } else {
      toast.info(`${f.label} export is simulated in this prototype — no file was generated.`);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <Download /> Export
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg rounded-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-[30px] font-normal">Export records</DialogTitle>
          <p className="text-[13px] text-muted-foreground">{label}</p>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {FORMATS.map((x) => (
            <button key={x.key} onClick={() => setFormat(x.key)} className={cn("rounded-md border px-3 py-2.5 text-left transition-colors", format === x.key ? "border-foreground bg-secondary" : "border-border hover:bg-secondary")}>
              <p className="text-[13.5px]">{x.label}</p>
              <p className={cn("num text-[10.5px] uppercase tracking-wider", x.works ? "text-success" : "text-warning")}>{x.note}</p>
            </button>
          ))}
        </div>
        <div className="space-y-2.5 border-y border-border py-4 text-[13.5px]">
          {(
            [
              ["Verified invoices only", verifiedOnly, setVerifiedOnly],
              ["Include invoices requiring review", includeReview, setIncludeReview],
              ["Exclude duplicates", excludeDup, setExcludeDup],
            ] as const
          ).map(([l, v, s]) => (
            <label key={l} className="flex cursor-pointer items-center gap-3">
              <Checkbox checked={v} onCheckedChange={(c) => s(!!c)} /> {l}
            </label>
          ))}
          <p className="num pt-1 text-[11px] text-muted-foreground">All fields included · {selected.length} of {invoices.length} invoices selected</p>
        </div>
        <div>
          <label className="text-[12.5px] text-muted-foreground">Filename template</label>
          <Input value={ws.filenameTemplate} onChange={(e) => actions.setTemplate(e.target.value)} className="num mt-1.5 text-[12.5px]" />
          {sample && <p className="num mt-2 truncate text-[12px] text-primary">→ {buildFileName(ws.filenameTemplate, sample)}</p>}
        </div>
        <Button variant="ink" onClick={run} disabled={!selected.length}>
          <Download /> {f.works ? `Download ${f.label}` : `Simulate ${f.label} export`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
