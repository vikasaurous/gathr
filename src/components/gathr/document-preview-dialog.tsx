import { Link } from "@tanstack/react-router";
import { AlertCircle, Download, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes } from "@/lib/gathr/format";
import {
  hasValidPdfHeader,
  normalizeMimeType,
  PDF_MIME_TYPE,
  type PersistedDocument,
} from "@/lib/gathr/ingestion-types";

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; blobUrl: string }
  | { status: "error"; message: string; unauthorized: boolean };

export function DocumentPreviewDialog({
  document: doc,
  open,
  onOpenChange,
  onDownload,
  onRefreshBatch,
  returnFocusTo,
}: {
  document: PersistedDocument | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDownload: (doc: PersistedDocument) => void;
  onRefreshBatch?: (() => void) | undefined;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const activeUrlRef = useRef<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open && typeof globalThis.document !== "undefined") {
      if (returnFocusTo) {
        openerRef.current = returnFocusTo;
      } else if (
        globalThis.document.activeElement instanceof HTMLElement &&
        globalThis.document.activeElement !== globalThis.document.body
      ) {
        openerRef.current = globalThis.document.activeElement;
      }
    }
  }, [open, returnFocusTo]);

  const revokeActiveUrl = useCallback(() => {
    if (activeUrlRef.current && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(activeUrlRef.current);
    }
    activeUrlRef.current = null;
  }, []);

  useEffect(() => {
    if (!open || !doc) {
      revokeActiveUrl();
      setPreview({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    revokeActiveUrl();
    setPreview({ status: "loading" });

    void (async () => {
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(doc.id)}/content`, {
          method: "GET",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        if (!res.ok) {
          let message =
            res.status === 404
              ? "This PDF could not be found in private storage."
              : res.status === 401
                ? "Your session has expired. Please sign in again to view this document."
                : "Could not load this PDF from private storage right now.";
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body.error === "string" && body.error) {
              message = body.error;
            }
          } catch {
            // Preserve safe fallback message
          }
          setPreview({
            status: "error",
            message,
            unauthorized: res.status === 401,
          });
          return;
        }

        const contentType = normalizeMimeType(res.headers.get("content-type"));
        if (contentType && contentType !== PDF_MIME_TYPE) {
          setPreview({
            status: "error",
            message: "Server returned an unexpected response instead of a valid PDF.",
            unauthorized: false,
          });
          return;
        }

        const blob = await res.blob();
        if (controller.signal.aborted) return;

        if (blob.size <= 0 || !(await hasValidPdfHeader(blob))) {
          setPreview({
            status: "error",
            message: "Retrieved PDF content was empty or corrupted.",
            unauthorized: false,
          });
          return;
        }

        if (typeof URL.createObjectURL !== "function") {
          setPreview({
            status: "error",
            message:
              "Inline PDF preview is unavailable in this browser environment. Try downloading the file instead.",
            unauthorized: false,
          });
          return;
        }

        const blobUrl = URL.createObjectURL(blob);
        activeUrlRef.current = blobUrl;
        setPreview({ status: "ready", blobUrl });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        setPreview({
          status: "error",
          message: "Network error while loading the private PDF. Please retry.",
          unauthorized: false,
        });
      }
    })();

    return () => {
      controller.abort();
      revokeActiveUrl();
    };
  }, [open, doc, reloadNonce, revokeActiveUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] max-w-4xl flex-col gap-4 overflow-hidden"
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo ?? openerRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader className="pr-8">
          <div className="flex items-start gap-2.5">
            <FileText className="mt-1 size-4 shrink-0 text-muted-foreground" strokeWidth={1.6} />
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate font-serif text-2xl font-normal">
                {doc?.originalFilename ?? "Document preview"}
              </DialogTitle>
              {doc && (
                <DialogDescription className="num mt-1 text-[11.5px] text-muted-foreground">
                  {doc.id} · {formatBytes(doc.fileSizeBytes)} · {doc.mimeType}
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>

        {doc && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-2.5">
            <span className="text-[12px] text-muted-foreground">
              Private workspace PDF stream (private, no-store)
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onDownload(doc)}
                aria-label={`Download ${doc.originalFilename} from preview`}
              >
                <Download className="size-3.5" /> Download PDF
              </Button>
              {preview.status === "ready" && (
                <Button variant="ghost" size="sm" asChild>
                  <a
                    href={`/api/documents/${encodeURIComponent(doc.id)}/content`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="size-3.5" /> Open in new tab
                  </a>
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="min-h-[320px] flex-1 overflow-auto">
          {preview.status === "loading" && (
            <div
              role="status"
              aria-live="polite"
              className="flex h-[320px] flex-col items-center justify-center gap-2 rounded-sm border border-dashed border-border bg-surface px-6 text-center"
            >
              <RefreshCw className="size-5 animate-spin text-muted-foreground" />
              <p className="text-[14px] font-medium">Loading private PDF…</p>
              <p className="text-[12.5px] text-muted-foreground">
                Verifying workspace access and streaming from private storage.
              </p>
            </div>
          )}

          {preview.status === "ready" && doc && (
            <iframe
              title={`PDF preview for ${doc.originalFilename}`}
              src={preview.blobUrl}
              className="h-[62vh] w-full rounded-sm border border-border bg-surface"
            />
          )}

          {preview.status === "error" && (
            <div
              role="alert"
              className="flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-sm border border-destructive/30 bg-destructive/5 px-6 py-8 text-center"
            >
              <AlertCircle className="size-6 text-destructive" strokeWidth={1.6} />
              <div className="max-w-md space-y-1">
                <p className="font-serif text-xl">PDF unavailable</p>
                <p className="text-[13px] text-muted-foreground">{preview.message}</p>
              </div>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {preview.unauthorized ? (
                  <Button variant="ink" size="sm" asChild>
                    <Link
                      to="/login"
                      search={{ verified: undefined, email: undefined, error: undefined }}
                    >
                      Sign in
                    </Link>
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setReloadNonce((n) => n + 1)}
                    >
                      <RefreshCw className="size-3.5" /> Retry preview
                    </Button>
                    {onRefreshBatch && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          onRefreshBatch();
                          onOpenChange(false);
                        }}
                      >
                        Refresh batch status
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
