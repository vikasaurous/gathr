import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  buildSafeFileName,
  downloadBlob,
  downloadCsv,
  downloadPdf,
  downloadXlsx,
  EXPORT_FORMATS,
  type ExportFormatKey,
  filterExportInvoices,
  invoicesToCsv,
  invoicesToPdfReport,
  invoicesToXlsx,
  invoicesToZip,
} from "@/lib/gathr/export";
import { actions, useWorkspace } from "@/lib/gathr/store";
import type { Invoice } from "@/lib/gathr/types";
import { cn } from "@/lib/utils";

export function ExportDialog({
  invoices,
  trigger,
  label,
}: {
  invoices: Invoice[];
  trigger?: React.ReactNode;
  label: string;
}) {
  const ws = useWorkspace();
  const [format, setFormat] = useState<ExportFormatKey>("csv");
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [includeReview, setIncludeReview] = useState(false);
  const [excludeDup, setExcludeDup] = useState(true);
  const [loading, setLoading] = useState(false);

  const selected = filterExportInvoices(invoices, {
    verifiedOnly,
    includeReview,
    excludeDup,
  });
  const f = EXPORT_FORMATS.find((x) => x.key === format)!;
  const sample = selected[0] ?? invoices[0];

  async function run() {
    if (loading || !selected.length) {
      if (!selected.length) {
        toast.error("No invoices match these options.");
      }
      return;
    }
    setLoading(true);
    try {
      const slugLabel =
        label
          .replace(/\W+/g, "-")
          .toLowerCase()
          .replace(/^-+|-+$/g, "") || "invoices";
      const datePart = new Date().toISOString().slice(0, 10);
      const baseName = `gathr_${slugLabel}_${datePart}`;

      if (format === "csv") {
        const csvContent = invoicesToCsv(selected);
        downloadCsv(`${baseName}.csv`, csvContent);
        toast.success(
          `CSV with ${selected.length} record${selected.length === 1 ? "" : "s"} downloaded`,
        );
      } else if (format === "xlsx") {
        const xlsxBytes = invoicesToXlsx(selected);
        downloadXlsx(`${baseName}.xlsx`, xlsxBytes);
        toast.success(
          `Excel workbook with ${selected.length} record${selected.length === 1 ? "" : "s"} downloaded`,
        );
      } else if (format === "pdf") {
        const pdfBytes = await invoicesToPdfReport(selected);
        downloadPdf(`${baseName}.pdf`, pdfBytes);
        toast.success(
          `PDF report with ${selected.length} invoice${selected.length === 1 ? "" : "s"} downloaded`,
        );
      } else if (format === "zip") {
        const zipBlob = await invoicesToZip(selected, ws.filenameTemplate);
        downloadBlob(`${baseName}.zip`, zipBlob);
        toast.success(
          `ZIP archive with ${selected.length} PDF summary${selected.length === 1 ? "" : "ies"} and CSV downloaded`,
        );
      }
    } catch (err) {
      console.error("Export generation error:", err);
      toast.error(
        err instanceof Error ? `Export failed: ${err.message}` : "Export failed. Please try again.",
      );
    } finally {
      setLoading(false);
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
          {EXPORT_FORMATS.map((x) => (
            <button
              key={x.key}
              type="button"
              disabled={loading}
              onClick={() => setFormat(x.key)}
              className={cn(
                "rounded-md border px-3 py-2.5 text-left transition-colors",
                format === x.key
                  ? "border-foreground bg-secondary"
                  : "border-border hover:bg-secondary",
                loading && "cursor-not-allowed opacity-60",
              )}
            >
              <p className="text-[13.5px] font-medium">{x.label}</p>
              <p className="text-[11px] text-muted-foreground">{x.description}</p>
            </button>
          ))}
        </div>
        <div className="space-y-2.5 border-y border-border py-4 text-[13.5px]">
          <label className="flex cursor-pointer items-center gap-3">
            <Checkbox
              checked={verifiedOnly}
              onCheckedChange={(c) => setVerifiedOnly(!!c)}
              disabled={loading}
            />{" "}
            Verified invoices only
          </label>
          <label
            className={cn(
              "flex items-center gap-3",
              !verifiedOnly ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            )}
          >
            <Checkbox
              checked={verifiedOnly ? includeReview : true}
              onCheckedChange={(c) => setIncludeReview(!!c)}
              disabled={loading || !verifiedOnly}
            />{" "}
            Include invoices requiring review
          </label>
          <label className="flex cursor-pointer items-center gap-3">
            <Checkbox
              checked={excludeDup}
              onCheckedChange={(c) => setExcludeDup(!!c)}
              disabled={loading}
            />{" "}
            Exclude duplicates
          </label>
          <p className="num pt-1 text-[11px] text-muted-foreground">
            All fields included · {selected.length} of {invoices.length} invoices selected
          </p>
        </div>
        <div>
          <label className="text-[12.5px] text-muted-foreground">Filename template</label>
          <Input
            value={ws.filenameTemplate}
            onChange={(e) => actions.setTemplate(e.target.value)}
            disabled={loading}
            className="num mt-1.5 text-[12.5px]"
          />
          {sample && (
            <p className="num mt-2 truncate text-[12px] text-primary">
              → {buildSafeFileName(ws.filenameTemplate, sample)}
            </p>
          )}
        </div>
        <Button variant="ink" onClick={run} disabled={loading || !selected.length}>
          {loading ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Generating {f.label}...
            </>
          ) : (
            <>
              <Download /> Download {f.label}
            </>
          )}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
