import { cn } from "@/lib/utils";
import {
  DOCUMENT_REVIEW_STATUS_META,
  isDocumentReviewStatus,
  type BatchIngestionStatus,
  type DocumentReviewStatus,
  type DocumentUploadStatus,
} from "@/lib/gathr/ingestion-types";
import type { BatchStatus, FieldSource, InvoiceStatus } from "@/lib/gathr/types";

const TONE = {
  success: "text-success bg-success/10",
  warning: "text-warning bg-warning/12",
  error: "text-destructive bg-destructive/10",
  neutral: "text-muted-foreground bg-secondary",
  accent: "text-primary bg-primary/10",
} as const;

export function Pill({
  tone,
  children,
  pulse,
}: {
  tone: keyof typeof TONE;
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-0.5 text-[11.5px] font-medium",
        TONE[tone],
      )}
    >
      <span className={cn("size-1.5 rounded-full bg-current", pulse && "animate-pulse")} />
      {children}
    </span>
  );
}

export function BatchStatusPill({ status }: { status: BatchStatus }) {
  const m = {
    processing: ["accent", "Processing"],
    completed: ["success", "Completed"],
    needs_review: ["warning", "Needs review"],
    failed: ["error", "Failed"],
  } as const;
  return (
    <Pill tone={m[status][0]} pulse={status === "processing"}>
      {m[status][1]}
    </Pill>
  );
}

export function IngestionBatchStatusPill({
  status,
  pendingOnly,
}: {
  status: BatchIngestionStatus;
  pendingOnly?: boolean;
}) {
  const labelMap = {
    uploading: ["accent", pendingOnly ? "Pending upload" : "Uploading"],
    uploaded: ["success", "Uploaded"],
    partial: ["warning", "Partial"],
    failed: ["error", "Failed"],
  } as const;
  return (
    <Pill tone={labelMap[status][0]} pulse={status === "uploading" && !pendingOnly}>
      {labelMap[status][1]}
    </Pill>
  );
}

export function DocumentUploadStatusPill({ status }: { status: DocumentUploadStatus }) {
  const labelMap = {
    pending_upload: ["neutral", "Pending upload"],
    uploading: ["accent", "Uploading"],
    uploaded: ["success", "Uploaded"],
    failed: ["error", "Upload failed"],
  } as const;
  return (
    <Pill tone={labelMap[status][0]} pulse={status === "uploading"}>
      {labelMap[status][1]}
    </Pill>
  );
}

export function DocumentReviewStatusPill({
  status,
}: {
  status: DocumentReviewStatus | null | undefined;
}) {
  const key = status && isDocumentReviewStatus(status) ? status : "unreviewed";
  const meta = DOCUMENT_REVIEW_STATUS_META[key];
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

export function InvoiceStatusPill({ status }: { status: InvoiceStatus | DocumentReviewStatus }) {
  const key = isDocumentReviewStatus(status) ? status : "needs_review";
  const meta = DOCUMENT_REVIEW_STATUS_META[key];
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

export function SourceTag({
  source,
  confidence,
}: {
  source: FieldSource;
  confidence: number | null;
}) {
  if (source === "missing")
    return (
      <span className="num text-[10.5px] uppercase tracking-wider text-destructive">Missing</span>
    );
  if (source === "corrected")
    return (
      <span className="num text-[10.5px] uppercase tracking-wider text-primary">Corrected</span>
    );
  const pct = Math.round((confidence ?? 0) * 100);
  const low = pct < 75;
  return (
    <span
      className={cn(
        "num inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider",
        low ? "text-warning" : "text-muted-foreground",
      )}
    >
      <span className="relative h-[3px] w-8 overflow-hidden rounded-full bg-border">
        <span
          className={cn("absolute inset-y-0 left-0", low ? "bg-warning" : "bg-success")}
          style={{ width: `${pct}%` }}
        />
      </span>
      {low ? "Unverified" : "Extracted"} {pct}%
    </span>
  );
}

export function DemoBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "num inline-flex items-center rounded-sm border border-warning/40 px-1.5 py-px text-[10px] uppercase tracking-wider text-warning",
        className,
      )}
    >
      Demo data
    </span>
  );
}
