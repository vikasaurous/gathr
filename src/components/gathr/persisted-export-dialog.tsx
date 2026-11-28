import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  buildPersistedExportBaseName,
  downloadBlob,
  EXPORT_FORMATS,
  type ExportFormatKey,
} from "@/lib/gathr/export";
import type {
  DocumentUploadStatus,
  PersistedExportFailure,
  PersistedExportRequest,
  PersistedExportReviewScope,
  PersistedExportScope,
} from "@/lib/gathr/ingestion-types";
import { cn } from "@/lib/utils";

const FORMAT_DESCRIPTIONS: Record<ExportFormatKey, string> = {
  csv: "Spreadsheet-compatible metadata",
  xlsx: "Structured Excel workbook (.xlsx)",
  pdf: "Multi-page document summary report",
  zip: "Original uploaded PDFs, CSV & manifest",
};

const REVIEW_SCOPE_OPTIONS: Array<{
  value: PersistedExportReviewScope;
  label: string;
  hint: string;
}> = [
  {
    value: "all",
    label: "All documents",
    hint: "Include all records matching active scope",
  },
  {
    value: "verified_only",
    label: "Verified only",
    hint: "Only uploaded documents marked Verified",
  },
  {
    value: "verified_and_review",
    label: "Verified & needs review",
    hint: "Uploaded documents marked Verified or Needs review",
  },
  {
    value: "exclude_excluded",
    label: "Exclude duplicates & rejected",
    hint: "Omit documents marked Duplicate or Rejected",
  },
];

function parseFilenameFromDisposition(
  header: string | null,
  fallbackBase: string,
  format: ExportFormatKey,
): string {
  if (header) {
    const match = /filename="([^"]+)"/i.exec(header);
    if (match?.[1]) return match[1];
  }
  return `${fallbackBase}.${format}`;
}

export interface PersistedExportDialogProps {
  scope: PersistedExportScope;
  batchId?: string | undefined;
  label: string;
  totalCount: number;
  disabled?: boolean | undefined;
  defaultQuery?: string | undefined;
  defaultUploadStatus?: DocumentUploadStatus | undefined;
  trigger?: React.ReactNode | undefined;
}

export function PersistedExportDialog({
  scope,
  batchId,
  label,
  totalCount,
  disabled = false,
  defaultQuery,
  defaultUploadStatus,
  trigger,
}: PersistedExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormatKey>("csv");
  const [reviewScope, setReviewScope] = useState<PersistedExportReviewScope>("all");
  const [applyActiveFilters, setApplyActiveFilters] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [failures, setFailures] = useState<PersistedExportFailure[]>([]);
  const [partialSummary, setPartialSummary] = useState<string | null>(null);

  const hasActiveFilter = Boolean(defaultQuery?.trim() || defaultUploadStatus);
  const selectedFormatMeta = EXPORT_FORMATS.find((x) => x.key === format)!;
  const previewBase = buildPersistedExportBaseName(label);

  async function runExport() {
    if (loading) return;
    setLoading(true);
    setErrorMessage(null);
    setFailures([]);
    setPartialSummary(null);

    try {
      const payload: PersistedExportRequest = {
        format,
        scope,
        ...(batchId ? { batchId } : {}),
        reviewScope,
        ...(applyActiveFilters && defaultUploadStatus ? { uploadStatus: defaultUploadStatus } : {}),
        ...(applyActiveFilters && defaultQuery?.trim() ? { query: defaultQuery.trim() } : {}),
      };

      const res = await fetch("/api/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as {
          error?: string;
          failures?: PersistedExportFailure[];
        } | null;
        const msg = errBody?.error ?? `Export failed (${res.status}).`;
        setErrorMessage(msg);
        if (Array.isArray(errBody?.failures)) {
          setFailures(errBody.failures);
        }
        toast.error(msg);
        return;
      }

      const blob = await res.blob();
      const fileName = parseFilenameFromDisposition(
        res.headers.get("Content-Disposition"),
        previewBase,
        format,
      );
      downloadBlob(fileName, blob);

      const exportStatus = res.headers.get("X-Gathr-Export-Status");
      const includedCount = Number(res.headers.get("X-Gathr-Export-Included-Count") ?? "0");
      const failedCount = Number(res.headers.get("X-Gathr-Export-Failed-Count") ?? "0");
      const failuresHeader = res.headers.get("X-Gathr-Export-Failures");

      if (exportStatus === "partial") {
        let parsedFailures: PersistedExportFailure[] = [];
        if (failuresHeader) {
          try {
            parsedFailures = JSON.parse(
              decodeURIComponent(failuresHeader),
            ) as PersistedExportFailure[];
          } catch {
            parsedFailures = [];
          }
        }
        setFailures(parsedFailures);
        const summary = `Partial ZIP downloaded: ${includedCount} PDF${includedCount === 1 ? "" : "s"} included, ${failedCount} unavailable.`;
        setPartialSummary(summary);
        toast.warning(summary);
      } else {
        const countText =
          includedCount > 0 ? `${includedCount} record${includedCount === 1 ? "" : "s"}` : "export";
        toast.success(`${selectedFormatMeta.label} (${countText}) downloaded`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed. Please try again.";
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setErrorMessage(null);
          setFailures([]);
          setPartialSummary(null);
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="outline" disabled={disabled || totalCount === 0}>
            <Download className="size-4" /> Export
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg rounded-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-[30px] font-normal">Export documents</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            {label} · Read-only workspace export
          </DialogDescription>
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
              <p className="text-[11px] text-muted-foreground">{FORMAT_DESCRIPTIONS[x.key]}</p>
            </button>
          ))}
        </div>

        <div className="space-y-2 border-y border-border py-4 text-[13px]">
          <p className="text-[12px] font-medium text-muted-foreground">Review status scope</p>
          <div className="space-y-1.5">
            {REVIEW_SCOPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-secondary/50"
              >
                <input
                  type="radio"
                  name="persisted-export-review-scope"
                  value={opt.value}
                  checked={reviewScope === opt.value}
                  onChange={() => setReviewScope(opt.value)}
                  disabled={loading}
                  className="mt-1 accent-foreground"
                />
                <span>
                  <span className="block font-medium text-foreground">{opt.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {hasActiveFilter && (
            <label className="mt-2 flex cursor-pointer items-center gap-2.5 pt-2 text-[12.5px]">
              <Checkbox
                checked={applyActiveFilters}
                onCheckedChange={(c) => setApplyActiveFilters(!!c)}
                disabled={loading}
              />
              Apply current search &amp; status filters
            </label>
          )}
        </div>

        <p className="num truncate text-[11.5px] text-muted-foreground">
          File: {previewBase}.{format}
        </p>

        {partialSummary && (
          <div
            role="status"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-foreground"
          >
            <p className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-4 text-amber-600" /> {partialSummary}
            </p>
            {failures.length > 0 && (
              <ul className="mt-1.5 max-h-28 space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
                {failures.map((f) => (
                  <li key={f.documentId}>
                    <span className="font-medium text-foreground">{f.filename}</span>: {f.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {errorMessage && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[12px] text-destructive"
          >
            <p className="font-medium">{errorMessage}</p>
            {failures.length > 0 && (
              <ul className="mt-1.5 max-h-28 space-y-1 overflow-y-auto text-[11px]">
                {failures.map((f) => (
                  <li key={f.documentId}>
                    {f.filename}: {f.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Button type="button" variant="ink" onClick={() => void runExport()} disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Generating {selectedFormatMeta.label}...
            </>
          ) : (
            <>
              <Download className="size-4" /> Download {selectedFormatMeta.label}
            </>
          )}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
