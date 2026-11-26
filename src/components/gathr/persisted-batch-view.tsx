import { Link } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, FileText, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/gathr/common";
import { DocumentUploadStatusPill, IngestionBatchStatusPill } from "@/components/gathr/status";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDate } from "@/lib/gathr/format";
import type { BatchDetailResponse } from "@/lib/gathr/ingestion-types";

export function PersistedBatchView({ batchId }: { batchId: string }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "not_found" }
    | { status: "error"; message: string }
    | { status: "ready"; data: BatchDetailResponse }
  >({ status: "loading" });

  const loadBatch = useCallback(
    async (signal?: AbortSignal) => {
      setState({ status: "loading" });
      try {
        const res = await fetch(`/api/batches/${encodeURIComponent(batchId)}`, {
          method: "GET",
          credentials: "same-origin",
          ...(signal ? { signal } : {}),
        });
        if (signal?.aborted) return;

        if (res.status === 404 || res.status === 400) {
          setState({ status: "not_found" });
          return;
        }
        if (res.status === 401) {
          setState({
            status: "error",
            message: "Your session has expired. Please sign in again to view this batch.",
          });
          return;
        }
        if (!res.ok) {
          let message = "Could not load batch details from the server.";
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body.error === "string" && body.error) message = body.error;
          } catch {
            // Keep safe fallback message
          }
          setState({ status: "error", message });
          return;
        }

        const data = (await res.json()) as BatchDetailResponse;
        setState({ status: "ready", data });
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) return;
        setState({
          status: "error",
          message: "Network error while loading this batch. Please try again.",
        });
      }
    },
    [batchId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadBatch(controller.signal);
    return () => controller.abort();
  }, [loadBatch]);

  if (state.status === "loading") {
    return (
      <div className="mx-auto max-w-[1040px] px-5 py-10 md:px-10 md:py-14">
        <p className="eyebrow">Batch</p>
        <p className="mt-4 text-[14px] text-muted-foreground">Loading batch from workspace…</p>
      </div>
    );
  }

  if (state.status === "not_found") {
    return (
      <div className="mx-auto max-w-[1040px] px-5 py-10 md:px-10 md:py-14">
        <EmptyState
          title="Batch not found."
          action={
            <Button variant="outline" asChild>
              <Link to="/app/batches">Back to batches</Link>
            </Button>
          }
        >
          This batch does not exist in your workspace or may have been removed.
        </EmptyState>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-[1040px] px-5 py-10 md:px-10 md:py-14">
        <EmptyState
          title="Could not load batch."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => void loadBatch()}>
                <RefreshCw className="size-4" /> Retry
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/app/batches">Back to batches</Link>
              </Button>
            </div>
          }
        >
          {state.message}
        </EmptyState>
      </div>
    );
  }

  const { batch, documents } = state.data;
  const totalBytes = documents.reduce((sum, doc) => sum + doc.fileSizeBytes, 0);
  const pendingOnly =
    documents.length > 0 && documents.every((doc) => doc.status === "pending_upload");

  return (
    <div className="mx-auto max-w-[1040px] px-5 py-8 md:px-10 md:py-12">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
        <div className="min-w-0">
          <Link
            to="/app/batches"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> All batches
          </Link>
          <h1 className="mt-3 truncate font-serif text-[36px] leading-tight md:text-[42px]">
            {batch.name}
          </h1>
          <p className="num mt-1.5 text-[11.5px] text-muted-foreground">
            {batch.id} · {documents.length} PDF document{documents.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(totalBytes)} · Created {formatDate(batch.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <IngestionBatchStatusPill status={batch.status} pendingOnly={pendingOnly} />
          <Button variant="ink" asChild>
            <Link to="/app/new">
              <Plus className="size-4" /> New batch
            </Link>
          </Button>
        </div>
      </div>

      <div className="mt-6 flex items-start gap-2.5 rounded-md border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.6} />
        <p>
          Batch saved to your workspace. Each PDF is tracked as an individual document record (no
          merging, splitting, or invoice content reading has occurred).
        </p>
      </div>

      {documents.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No documents in this batch." />
        </div>
      ) : (
        <section className="mt-8" aria-label="Prepared PDF documents">
          <h2 className="eyebrow mb-3">Documents ({documents.length})</h2>
          <ul className="border-t border-foreground">
            {documents.map((doc, idx) => (
              <li
                key={doc.id}
                className="flex flex-wrap items-center justify-between gap-4 border-b border-border py-4"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="num pt-0.5 text-[11px] text-muted-foreground">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <FileText
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">{doc.originalFilename}</p>
                    <p className="num mt-0.5 text-[11px] text-muted-foreground">
                      {doc.id} · {formatBytes(doc.fileSizeBytes)} · {doc.mimeType}
                    </p>
                    {doc.errorMessage && (
                      <p className="mt-1 text-[12px] text-destructive">{doc.errorMessage}</p>
                    )}
                  </div>
                </div>
                <DocumentUploadStatusPill status={doc.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
