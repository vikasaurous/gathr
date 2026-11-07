import { FileText, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { formatBytes } from "@/lib/gathr/format";
import { cn } from "@/lib/utils";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 25;

export interface QueuedFile {
  id: string;
  file: File;
  error?: string;
}

export function checkFile(f: File): string | undefined {
  const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "Only PDF files are supported.";
  if (f.size > MAX_FILE_BYTES) return "File is larger than 50 MB.";
  if (f.size === 0) return "File is empty.";
}

export function FileDrop({ files, onAdd, onRemove, disabled }: { files: QueuedFile[]; onAdd: (f: File[]) => void; onRemove: (id: string) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload PDF files"
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) onAdd(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          "group relative flex min-h-[260px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-foreground/25 bg-surface px-6 py-14 text-center transition-colors",
          over && "border-primary bg-primary/5",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="relative mb-6 h-16 w-14">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute inset-0 rounded-sm border border-border bg-paper transition-transform duration-500"
              style={{ transform: over ? `rotate(${(i - 1) * 2}deg)` : `rotate(${(i - 1) * 9}deg) translateX(${(i - 1) * 6}px)` }}
            />
          ))}
          <Upload className="absolute inset-0 m-auto size-5 text-primary" strokeWidth={1.5} />
        </div>
        <p className="font-serif text-[26px] leading-tight">{over ? "Release to add" : "Drop PDFs here"}</p>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          or <span className="text-foreground underline underline-offset-4">browse your files</span>
        </p>
        <p className="num mt-6 text-[11px] text-muted-foreground">PDF only · up to {MAX_FILES} files · 50 MB each · combined or individual invoices</p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            onAdd(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      {files.length > 0 && (
        <ul className="mt-6 border-t border-border">
          {files.map((q) => (
            <li key={q.id} className="flex items-center gap-3 border-b border-border py-3">
              <FileText className={cn("size-4 shrink-0", q.error ? "text-destructive" : "text-muted-foreground")} strokeWidth={1.5} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px]">{q.file.name}</p>
                <p className={cn("num text-[11px]", q.error ? "text-destructive" : "text-muted-foreground")}>
                  {formatBytes(q.file.size)} · {q.error ?? "Ready"}
                </p>
              </div>
              <button disabled={disabled} onClick={() => onRemove(q.id)} className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" aria-label={`Remove ${q.file.name}`}>
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
