import { AlertCircle, CheckCircle2, FileText, Loader2, Upload, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { formatBytes } from "@/lib/gathr/format";
import {
  checkPdfFileMetadata,
  MAX_FILE_BYTES,
  MAX_FILES_PER_BATCH,
} from "@/lib/gathr/ingestion-types";
import { cn } from "@/lib/utils";

export { MAX_FILE_BYTES };
export const MAX_FILES = MAX_FILES_PER_BATCH;

export interface QueuedFile {
  id: string;
  file: File;
  sanitizedName: string;
  displayName: string;
  validating?: boolean | undefined;
  error?: string | undefined;
}

export function checkFile(f: File): string | undefined {
  return checkPdfFileMetadata(f);
}

export function FileDrop({
  files,
  onAdd,
  onRemove,
  disabled,
}: {
  files: QueuedFile[];
  onAdd: (f: File[]) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const isDisabled = Boolean(disabled);

  function openPicker() {
    if (isDisabled) return;
    inputRef.current?.click();
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={isDisabled ? -1 : 0}
        aria-label="Select PDF files"
        aria-describedby={hintId}
        aria-disabled={isDisabled ? "true" : undefined}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (isDisabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!isDisabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!isDisabled && e.dataTransfer.files.length > 0) {
            onAdd(Array.from(e.dataTransfer.files));
          }
        }}
        className={cn(
          "group relative flex min-h-[250px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-foreground/25 bg-surface px-6 py-12 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          over && !isDisabled && "border-primary bg-primary/5",
          isDisabled && "cursor-not-allowed opacity-50",
        )}
      >
        <div className="relative mb-6 h-16 w-14">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute inset-0 rounded-sm border border-border bg-paper transition-transform duration-500"
              style={{
                transform:
                  over && !isDisabled
                    ? `rotate(${(i - 1) * 2}deg)`
                    : `rotate(${(i - 1) * 9}deg) translateX(${(i - 1) * 6}px)`,
              }}
            />
          ))}
          <Upload className="absolute inset-0 m-auto size-5 text-primary" strokeWidth={1.5} />
        </div>
        <p className="font-serif text-[26px] leading-tight">
          {over && !isDisabled ? "Release to add PDFs" : "Drop invoice PDFs here"}
        </p>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          or <span className="text-foreground underline underline-offset-4">browse your files</span>
        </p>
        <p id={hintId} className="num mt-6 text-[11px] text-muted-foreground">
          PDF only · up to {MAX_FILES} files · 50 MiB each · one PDF becomes one document
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          disabled={isDisabled}
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(e) => {
            if (isDisabled) return;
            const picked = Array.from(e.target.files ?? []);
            if (picked.length > 0) onAdd(picked);
            e.target.value = "";
          }}
        />
      </div>

      {files.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted-foreground">
          No PDFs selected yet. Add one or more individual invoice PDFs to prepare this batch.
        </p>
      ) : (
        <ul className="mt-6 border-t border-border" aria-label="Selected PDF files">
          {files.map((q) => {
            const wasNormalized = q.displayName !== q.file.name;
            return (
              <li
                key={q.id}
                className="flex items-center gap-3 border-b border-border py-3"
                data-file-status={q.error ? "invalid" : q.validating ? "validating" : "ready"}
              >
                {q.error ? (
                  <AlertCircle className="size-4 shrink-0 text-destructive" strokeWidth={1.5} />
                ) : q.validating ? (
                  <Loader2
                    className="size-4 shrink-0 animate-spin text-muted-foreground"
                    strokeWidth={1.5}
                  />
                ) : (
                  <CheckCircle2 className="size-4 shrink-0 text-success" strokeWidth={1.5} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FileText
                      className="size-3.5 shrink-0 text-muted-foreground"
                      strokeWidth={1.5}
                    />
                    <p className="truncate text-[13.5px] font-medium">{q.displayName}</p>
                  </div>
                  {wasNormalized && (
                    <p className="num truncate text-[11px] text-muted-foreground">
                      Selected as “{q.file.name}”
                    </p>
                  )}
                  <p
                    className={cn(
                      "num mt-0.5 text-[11px]",
                      q.error
                        ? "text-destructive"
                        : q.validating
                          ? "text-muted-foreground"
                          : "text-success",
                    )}
                  >
                    {formatBytes(q.file.size)} ·{" "}
                    {q.error
                      ? q.error
                      : q.validating
                        ? "Checking PDF signature…"
                        : "Ready to submit"}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    if (!isDisabled) onRemove(q.id);
                  }}
                  className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                  aria-label={`Remove ${q.displayName}`}
                >
                  <X className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
