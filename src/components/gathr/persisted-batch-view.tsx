import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ConfirmDialog, EmptyState } from "@/components/gathr/common";
import {
  DocumentUploadStatusPill,
  IngestionBatchStatusPill,
  Pill,
} from "@/components/gathr/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes, formatDate } from "@/lib/gathr/format";
import {
  checkPdfFileMetadata,
  hasValidPdfHeader,
  type BatchDetailResponse,
  type FinalizeBatchResponse,
  type PersistedBatch,
  type PersistedDocument,
} from "@/lib/gathr/ingestion-types";
import {
  MAX_CONCURRENT_UPLOADS,
  uploadOrchestrator,
  type DocumentUploadEntry,
} from "@/lib/gathr/upload-orchestrator";

export function PersistedBatchView({
  batchId,
  onDeleted,
}: {
  batchId: string;
  onDeleted?: (() => void) | undefined;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "not_found" }
    | { status: "deleted" }
    | { status: "error"; message: string }
    | { status: "ready"; data: BatchDetailResponse }
  >({ status: "loading" });

  const [reattachErrors, setReattachErrors] = useState<Record<string, string>>({});
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [confirmIncompleteFinalize, setConfirmIncompleteFinalize] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const uploadEntries = useSyncExternalStore(
    uploadOrchestrator.subscribe,
    () => uploadOrchestrator.getBatchEntries(batchId),
    () => uploadOrchestrator.getBatchEntries(batchId),
  );

  const handleServerUpdate = useCallback(
    (payload: { document: PersistedDocument; batch: PersistedBatch }) => {
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        return {
          status: "ready",
          data: {
            batch: payload.batch,
            documents: prev.data.documents.map((doc) =>
              doc.id === payload.document.id ? payload.document : doc,
            ),
          },
        };
      });
    },
    [],
  );

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
        uploadOrchestrator.startBatch(batchId, data.documents, handleServerUpdate);
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) return;
        setState({
          status: "error",
          message: "Network error while loading this batch. Please try again.",
        });
      }
    },
    [batchId, handleServerUpdate],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadBatch(controller.signal);
    return () => {
      controller.abort();
      uploadOrchestrator.unregisterCallback(batchId);
    };
  }, [batchId, loadBatch]);

  async function handleReattachFile(doc: PersistedDocument, pickedFile: File) {
    setReattachErrors((prev) => {
      const next = { ...prev };
      delete next[doc.id];
      return next;
    });

    const metaError = checkPdfFileMetadata(pickedFile);
    if (metaError) {
      setReattachErrors((prev) => ({ ...prev, [doc.id]: metaError }));
      return;
    }

    if (pickedFile.size !== doc.fileSizeBytes) {
      setReattachErrors((prev) => ({
        ...prev,
        [doc.id]: `Selected file size (${formatBytes(pickedFile.size)}) does not match this document record (${formatBytes(doc.fileSizeBytes)}).`,
      }));
      return;
    }

    let validSig = false;
    try {
      validSig = await hasValidPdfHeader(pickedFile);
    } catch {
      validSig = false;
    }
    if (!validSig) {
      setReattachErrors((prev) => ({
        ...prev,
        [doc.id]: "File is not a valid PDF (missing %PDF- signature).",
      }));
      return;
    }

    uploadOrchestrator.uploadFileForDocument(batchId, doc.id, pickedFile, handleServerUpdate);
  }

  async function handleFinalizeBatch(allowIncomplete = false) {
    if (isFinalizing || isDeleting) return;
    setIsFinalizing(true);
    setLifecycleError(null);
    setConfirmIncompleteFinalize(false);

    try {
      const res = await fetch(`/api/batches/${encodeURIComponent(batchId)}/finalize`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowIncomplete }),
      });

      if (!res.ok) {
        let message = "Could not finalize batch.";
        let code: string | undefined;
        try {
          const body = (await res.json()) as { error?: unknown; code?: unknown };
          if (typeof body.error === "string" && body.error) message = body.error;
          if (typeof body.code === "string") code = body.code;
        } catch {
          // Keep safe fallback message
        }

        if (res.status === 409 && code === "BATCH_HAS_UNRESOLVED_DOCUMENTS" && !allowIncomplete) {
          setConfirmIncompleteFinalize(true);
          setIsFinalizing(false);
          return;
        }

        setLifecycleError(message);
        setIsFinalizing(false);
        return;
      }

      const data = (await res.json()) as FinalizeBatchResponse;
      setState({
        status: "ready",
        data: {
          batch: data.batch,
          documents: data.documents,
        },
      });
      toast.success(
        data.batch.status === "partial"
          ? "Batch finalized with partial uploads"
          : data.batch.status === "failed"
            ? "Batch finalized (no documents uploaded)"
            : "Batch finalized",
      );
      setIsFinalizing(false);
    } catch {
      setLifecycleError("Network error while finalizing batch. Please retry.");
      setIsFinalizing(false);
    }
  }

  async function handleDeleteBatch() {
    if (isDeleting || isFinalizing) return;
    setIsDeleting(true);
    setLifecycleError(null);

    try {
      uploadOrchestrator.cancelBatchLocalUploads(batchId);
      const res = await fetch(`/api/batches/${encodeURIComponent(batchId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        let message = "Could not delete batch.";
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error) message = body.error;
        } catch {
          // Keep safe fallback message
        }
        setLifecycleError(message);
        setIsDeleting(false);
        return;
      }

      toast.success("Batch deleted");
      if (onDeleted) {
        onDeleted();
      } else {
        setState({ status: "deleted" });
      }
    } catch {
      setLifecycleError("Network error while deleting batch. Please retry.");
      setIsDeleting(false);
    }
  }

  if (state.status === "loading") {
    return (
      <div className="mx-auto max-w-[1040px] px-5 py-10 md:px-10 md:py-14">
        <p className="eyebrow">Batch</p>
        <p className="mt-4 text-[14px] text-muted-foreground">Loading batch from workspace…</p>
      </div>
    );
  }

  if (state.status === "deleted") {
    return (
      <div className="mx-auto max-w-[1040px] px-5 py-10 md:px-10 md:py-14">
        <EmptyState
          title="Batch deleted."
          action={
            <Button variant="outline" asChild>
              <Link to="/app/batches">Back to batches</Link>
            </Button>
          }
        >
          This batch has been removed from your workspace and any stored files are queued for
          cleanup.
        </EmptyState>
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
  const isFinalized = Boolean(batch.finalizedAt);
  const totalBytes = documents.reduce((sum, doc) => sum + doc.fileSizeBytes, 0);
  const uploadedCount = documents.filter((doc) => doc.status === "uploaded").length;
  const failedCount = documents.filter((doc) => doc.status === "failed").length;
  const activeLocalCount = documents.filter((doc) => {
    const entry = uploadEntries.get(doc.id);
    return (
      entry &&
      (entry.phase === "uploading" || entry.phase === "queued" || entry.phase === "cancelling")
    );
  }).length;
  const pendingOnly =
    documents.length > 0 &&
    activeLocalCount === 0 &&
    documents.every((doc) => doc.status === "pending_upload");

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
            {batch.finalizedAt ? ` · Finalized ${formatDate(batch.finalizedAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <IngestionBatchStatusPill status={batch.status} pendingOnly={pendingOnly} />
          {isFinalized && (
            <Pill tone="neutral">
              <Lock className="size-3" /> Finalized
            </Pill>
          )}
          {!isFinalized && (
            <Button
              type="button"
              variant="outline"
              disabled={activeLocalCount > 0 || isFinalizing || isDeleting}
              onClick={() => void handleFinalizeBatch(false)}
            >
              <CheckCircle2 className="size-4" /> {isFinalizing ? "Finalizing…" : "Finalize batch"}
            </Button>
          )}
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="outline"
                disabled={isDeleting || isFinalizing}
                aria-label={`Delete batch ${batch.name}`}
              >
                <Trash2 className="size-4" /> {isDeleting ? "Deleting…" : "Delete batch"}
              </Button>
            }
            title="Delete this batch?"
            description="This removes the batch and its document records from your workspace and schedules any uploaded or in-flight PDF objects for permanent storage cleanup."
            confirmLabel="Delete batch"
            destructive
            onConfirm={() => void handleDeleteBatch()}
          />
          <Button variant="ink" asChild>
            <Link to="/app/new">
              <Plus className="size-4" /> New batch
            </Link>
          </Button>
        </div>
      </div>

      {lifecycleError && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <p>{lifecycleError}</p>
        </div>
      )}

      <div className="mt-6 flex items-start justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
        <div className="flex items-start gap-2.5">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.6} />
          <p>
            {activeLocalCount > 0
              ? `Uploading documents to private storage (${uploadedCount} of ${documents.length} confirmed · max ${MAX_CONCURRENT_UPLOADS} concurrent uploads).`
              : isFinalized
                ? batch.status === "partial"
                  ? `Batch finalized as partial: ${uploadedCount} of ${documents.length} uploaded, ${failedCount} failed. Sealed against further upload attempts (not all documents succeeded).`
                  : batch.status === "failed"
                    ? "Batch finalized with 0 uploaded documents. Sealed against further upload attempts."
                    : `Batch finalized: all ${documents.length} PDF document${documents.length === 1 ? "" : "s"} stored privately in your workspace and sealed against further upload mutations.`
                : batch.status === "uploaded"
                  ? `All ${documents.length} PDF document${documents.length === 1 ? "" : "s"} stored privately in your workspace. Finalize batch when ready to seal intake.`
                  : batch.status === "partial"
                    ? `${uploadedCount} of ${documents.length} documents stored; ${failedCount} failed and can be retried before finalizing.`
                    : "Batch saved to your workspace. Each PDF is stored and tracked as an individual private document (no merging, splitting, or invoice content reading has occurred)."}
          </p>
        </div>
        <span className="num shrink-0 text-[11.5px] text-foreground">
          {uploadedCount}/{documents.length} uploaded
        </span>
      </div>

      {documents.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No documents in this batch." />
        </div>
      ) : (
        <section className="mt-8" aria-label="Prepared PDF documents">
          <h2 className="eyebrow mb-3">Documents ({documents.length})</h2>
          <ul className="border-t border-foreground">
            {documents.map((doc, idx) => {
              const entry: DocumentUploadEntry | undefined = uploadEntries.get(doc.id);
              const isLocallyUploading = entry?.phase === "uploading";
              const isLocallyQueued = entry?.phase === "queued";
              const isLocallyCancelling = entry?.phase === "cancelling";
              const isCancelUnconfirmed = entry?.phase === "cancel_unconfirmed";
              const effectiveStatus =
                doc.status === "uploaded"
                  ? "uploaded"
                  : isLocallyUploading
                    ? "uploading"
                    : isLocallyCancelling ||
                        isCancelUnconfirmed ||
                        entry?.phase === "failed" ||
                        entry?.phase === "cancelled"
                      ? "failed"
                      : doc.status;
              const inlineError =
                reattachErrors[doc.id] ??
                (doc.status !== "uploaded" ? (entry?.errorMessage ?? doc.errorMessage) : null);
              const canRetryInMemory =
                !isFinalized &&
                doc.status !== "uploaded" &&
                !isLocallyUploading &&
                !isLocallyQueued &&
                !isLocallyCancelling &&
                Boolean(entry?.file);
              const canAttachAndUpload =
                !isFinalized &&
                doc.status !== "uploaded" &&
                doc.status !== "uploading" &&
                !isLocallyUploading &&
                !isLocallyQueued &&
                !isLocallyCancelling &&
                !entry?.file;
              const isStrandedServerUpload =
                !isFinalized &&
                doc.status === "uploading" &&
                !isLocallyUploading &&
                !isLocallyQueued &&
                !isLocallyCancelling;

              return (
                <li
                  key={doc.id}
                  className="flex flex-col gap-3 border-b border-border py-4"
                  data-document-id={doc.id}
                  data-upload-status={effectiveStatus}
                >
                  <div className="flex flex-wrap items-center justify-between gap-4">
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
                        {isLocallyQueued && doc.status !== "uploaded" && (
                          <p className="num mt-1 text-[11.5px] text-muted-foreground">
                            Queued — waiting for an open upload slot (max {MAX_CONCURRENT_UPLOADS}{" "}
                            concurrent)
                          </p>
                        )}
                        {inlineError && (
                          <p role="alert" className="mt-1 text-[12px] text-destructive">
                            {inlineError}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <DocumentUploadStatusPill status={effectiveStatus} />

                      {(isLocallyUploading || isLocallyQueued) && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Cancel upload for ${doc.originalFilename}`}
                          onClick={() =>
                            void uploadOrchestrator.cancelDocument(
                              batchId,
                              doc.id,
                              handleServerUpdate,
                              doc.activeAttemptId,
                            )
                          }
                        >
                          <X className="size-3.5" /> Cancel
                        </Button>
                      )}

                      {isLocallyCancelling && (
                        <Button type="button" variant="outline" size="sm" disabled>
                          Cancelling…
                        </Button>
                      )}

                      {isCancelUnconfirmed && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Confirm server cancellation for ${doc.originalFilename}`}
                          onClick={() =>
                            void uploadOrchestrator.cancelStuckServerUpload(
                              batchId,
                              doc.id,
                              handleServerUpdate,
                              doc.activeAttemptId,
                            )
                          }
                        >
                          <X className="size-3.5" /> Confirm cancel
                        </Button>
                      )}

                      {isStrandedServerUpload && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Cancel upload for ${doc.originalFilename}`}
                          onClick={() =>
                            void uploadOrchestrator.cancelStuckServerUpload(
                              batchId,
                              doc.id,
                              handleServerUpdate,
                              doc.activeAttemptId,
                            )
                          }
                        >
                          <X className="size-3.5" /> Cancel stalled upload
                        </Button>
                      )}

                      {canRetryInMemory && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Retry upload for ${doc.originalFilename}`}
                          onClick={() =>
                            void uploadOrchestrator.retryDocument(
                              batchId,
                              doc.id,
                              handleServerUpdate,
                            )
                          }
                        >
                          <RotateCcw className="size-3.5" /> Retry
                        </Button>
                      )}

                      {canAttachAndUpload && (
                        <>
                          <input
                            ref={(el) => {
                              fileInputRefs.current[doc.id] = el;
                            }}
                            type="file"
                            accept="application/pdf,.pdf"
                            tabIndex={-1}
                            aria-hidden="true"
                            className="hidden"
                            onChange={(e) => {
                              const picked = e.target.files?.[0];
                              e.target.value = "";
                              if (picked) {
                                void handleReattachFile(doc, picked);
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Upload PDF for ${doc.originalFilename}`}
                            onClick={() => fileInputRefs.current[doc.id]?.click()}
                          >
                            <Upload className="size-3.5" />{" "}
                            {doc.status === "failed" ? "Re-upload PDF" : "Upload PDF"}
                          </Button>
                        </>
                      )}

                      {doc.status === "uploaded" && (
                        <>
                          <Button variant="outline" size="sm" asChild>
                            <a
                              href={`/api/documents/${encodeURIComponent(doc.id)}/content`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`View ${doc.originalFilename}`}
                            >
                              <ExternalLink className="size-3.5" /> View PDF
                            </a>
                          </Button>
                          <Button variant="ghost" size="sm" asChild>
                            <a
                              href={`/api/documents/${encodeURIComponent(doc.id)}/content?download=1`}
                              download={doc.originalFilename}
                              aria-label={`Download ${doc.originalFilename}`}
                            >
                              <Download className="size-3.5" /> Download
                            </a>
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {isLocallyUploading && entry && (
                    <div className="pl-9 pr-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="num">
                          {formatBytes(entry.loadedBytes)} / {formatBytes(entry.totalBytes)}
                        </span>
                        <span className="num font-medium text-foreground">
                          {entry.progressPercent}%
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`Upload progress for ${doc.originalFilename}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={entry.progressPercent}
                        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border"
                      >
                        <div
                          className="h-full bg-primary transition-[width] duration-150"
                          style={{ width: `${entry.progressPercent}%` }}
                        />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Dialog open={confirmIncompleteFinalize} onOpenChange={setConfirmIncompleteFinalize}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl font-normal">
              Finalize incomplete batch?
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              Some documents in this batch are still pending upload. Finalizing now marks unuploaded
              documents as failed and seals the batch against future upload retries.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmIncompleteFinalize(false)}
            >
              Keep uploading
            </Button>
            <Button
              type="button"
              variant="ink"
              disabled={isFinalizing}
              onClick={() => void handleFinalizeBatch(true)}
            >
              Finalize anyway
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
