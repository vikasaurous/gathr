import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Eye,
  FileText,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ConfirmDialog, EmptyState, FilterTabs } from "@/components/gathr/common";
import { DocumentPreviewDialog } from "@/components/gathr/document-preview-dialog";
import { PersistedDocumentReviewDialog } from "@/components/gathr/persisted-document-review-dialog";
import {
  DocumentReviewStatusPill,
  DocumentUploadStatusPill,
  IngestionBatchStatusPill,
  Pill,
} from "@/components/gathr/status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { downloadCsv, persistedDocumentsToCsv } from "@/lib/gathr/export";
import { formatBytes, formatDate } from "@/lib/gathr/format";
import {
  checkPdfFileMetadata,
  DOCUMENT_REVIEW_STATUSES,
  formatReviewStatusLabel,
  hasValidPdfHeader,
  type BatchDetailResponse,
  type DeleteDocumentResponse,
  type DocumentUploadStatus,
  type EffectiveDocumentReviewState,
  type FinalizeBatchResponse,
  type PersistedBatch,
  type PersistedDocument,
} from "@/lib/gathr/ingestion-types";
import {
  MAX_CONCURRENT_UPLOADS,
  uploadOrchestrator,
  type DocumentUploadEntry,
} from "@/lib/gathr/upload-orchestrator";

type DocFilter = "all" | DocumentUploadStatus;
type ReviewFilter = "all" | EffectiveDocumentReviewState;

export function PersistedBatchView({
  batchId,
  selectedDocId,
  onSelectDoc,
  onDeleted,
}: {
  batchId: string;
  selectedDocId?: string | undefined;
  onSelectDoc?: ((docId: string | undefined) => void) | undefined;
  onDeleted?: (() => void) | undefined;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "not_found" }
    | { status: "deleted" }
    | { status: "error"; message: string; unauthorized?: boolean }
    | { status: "ready"; data: BatchDetailResponse }
  >({ status: "loading" });

  const [reattachErrors, setReattachErrors] = useState<Record<string, string>>({});
  const [docAccessErrors, setDocAccessErrors] = useState<Record<string, string>>({});
  const [downloadingDocIds, setDownloadingDocIds] = useState<Record<string, boolean>>({});
  const [deletingDocIds, setDeletingDocIds] = useState<Record<string, boolean>>({});
  const [previewDoc, setPreviewDoc] = useState<PersistedDocument | null>(null);
  const previewOpenerRef = useRef<HTMLElement | null>(null);
  const [localReviewDocId, setLocalReviewDocId] = useState<string | null>(null);
  const reviewOpenerRef = useRef<HTMLElement | null>(null);
  const activeReviewDocId = selectedDocId ?? localReviewDocId;
  const setReviewDocId = useCallback(
    (docId: string | null) => {
      setLocalReviewDocId(docId);
      onSelectDoc?.(docId ?? undefined);
    },
    [onSelectDoc],
  );
  const [pendingDocDelete, setPendingDocDelete] = useState<{
    doc: PersistedDocument;
    nextFocusDocId: string | null;
  } | null>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const deleteConfirmedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const activeLoadControllerRef = useRef<AbortController | null>(null);
  const [docQuery, setDocQuery] = useState("");
  const [docFilter, setDocFilter] = useState<DocFilter>("all");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [confirmIncompleteFinalize, setConfirmIncompleteFinalize] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isSameBatchReadyRef = useRef(false);
  isSameBatchReadyRef.current = state.status === "ready" && state.data.batch.id === batchId;
  const [pendingFocusTarget, setPendingFocusTarget] = useState<
    { type: "doc"; docId: string } | { type: "section" } | null
  >(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const sectionHeadingRef = useRef<HTMLHeadingElement | null>(null);

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
    async (externalSignal?: AbortSignal) => {
      const seq = ++loadSeqRef.current;
      activeLoadControllerRef.current?.abort();
      const localController = new AbortController();
      activeLoadControllerRef.current = localController;
      const onExternalAbort = () => localController.abort();
      if (externalSignal) {
        if (externalSignal.aborted) {
          localController.abort();
        } else {
          externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }
      const signal = localController.signal;

      if (isSameBatchReadyRef.current) {
        setIsRefreshing(true);
      } else {
        setIsRefreshing(false);
        setState({ status: "loading" });
      }
      try {
        const res = await fetch(`/api/batches/${encodeURIComponent(batchId)}`, {
          method: "GET",
          credentials: "same-origin",
          signal,
        });
        if (signal.aborted || seq !== loadSeqRef.current) return;

        if (res.status === 404 || res.status === 400) {
          setState({ status: "not_found" });
          return;
        }
        if (res.status === 401) {
          setState({
            status: "error",
            message: "Your session has expired. Please sign in again to view this batch.",
            unauthorized: true,
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
          if (signal.aborted || seq !== loadSeqRef.current) return;
          setState({ status: "error", message });
          return;
        }

        const data = (await res.json()) as BatchDetailResponse;
        if (signal.aborted || seq !== loadSeqRef.current) return;
        setState({ status: "ready", data });
        uploadOrchestrator.startBatch(batchId, data.documents, handleServerUpdate);
      } catch (err) {
        if (
          signal.aborted ||
          seq !== loadSeqRef.current ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        setState({
          status: "error",
          message: "Network error while loading this batch. Please try again.",
        });
      } finally {
        externalSignal?.removeEventListener("abort", onExternalAbort);
        if (seq === loadSeqRef.current) {
          setIsRefreshing(false);
        }
      }
    },
    [batchId, handleServerUpdate],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadBatch(controller.signal);
    return () => {
      controller.abort();
      activeLoadControllerRef.current?.abort();
      uploadOrchestrator.unregisterCallback(batchId);
    };
  }, [batchId, loadBatch]);

  useEffect(() => {
    if (!pendingFocusTarget || state.status !== "ready") return;
    if (pendingFocusTarget.type === "doc") {
      const row = rowRefs.current[pendingFocusTarget.docId];
      const focusable = row?.querySelector<HTMLElement>(
        "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
      );
      if (focusable) {
        focusable.focus();
      } else {
        sectionHeadingRef.current?.focus();
      }
    } else {
      sectionHeadingRef.current?.focus();
    }
    setPendingFocusTarget(null);
  }, [pendingFocusTarget, state.status]);

  async function handleDownloadDocument(doc: PersistedDocument) {
    if (downloadingDocIds[doc.id]) return;
    setDownloadingDocIds((prev) => ({ ...prev, [doc.id]: true }));
    setDocAccessErrors((prev) => {
      const next = { ...prev };
      delete next[doc.id];
      return next;
    });

    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(doc.id)}/content?download=1`, {
        method: "GET",
        credentials: "same-origin",
      });

      if (!res.ok) {
        let message =
          res.status === 404
            ? "Stored PDF object could not be found."
            : res.status === 401
              ? "Your session has expired. Please sign in again."
              : "Could not download PDF from private storage.";
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error) {
            message = body.error;
          }
        } catch {
          // Keep safe fallback message
        }
        setDocAccessErrors((prev) => ({ ...prev, [doc.id]: message }));
        toast.error(message);
        return;
      }

      const blob = await res.blob();
      if (blob.size <= 0 || !(await hasValidPdfHeader(blob))) {
        const message = "Retrieved PDF content was empty or corrupted.";
        setDocAccessErrors((prev) => ({ ...prev, [doc.id]: message }));
        toast.error(message);
        return;
      }

      if (typeof URL.createObjectURL === "function" && typeof document !== "undefined") {
        const blobUrl = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement("a");
          anchor.href = blobUrl;
          anchor.download = doc.originalFilename;
          anchor.style.display = "none";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        } finally {
          setTimeout(() => {
            if (typeof URL.revokeObjectURL === "function") {
              URL.revokeObjectURL(blobUrl);
            }
          }, 0);
        }
      }
    } catch {
      const message = "Network error while downloading PDF. Please retry.";
      setDocAccessErrors((prev) => ({ ...prev, [doc.id]: message }));
      toast.error(message);
    } finally {
      setDownloadingDocIds((prev) => {
        const next = { ...prev };
        delete next[doc.id];
        return next;
      });
    }
  }

  async function handleDeleteDocument(doc: PersistedDocument, nextFocusDocId: string | null) {
    if (deletingDocIds[doc.id] || isDeleting || isFinalizing) return;
    setDeletingDocIds((prev) => ({ ...prev, [doc.id]: true }));
    setLifecycleError(null);
    setDocAccessErrors((prev) => {
      const next = { ...prev };
      delete next[doc.id];
      return next;
    });

    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(doc.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        let message = "Could not remove document from batch.";
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error) {
            message = body.error;
          }
        } catch {
          // Keep safe fallback message
        }
        setDocAccessErrors((prev) => ({ ...prev, [doc.id]: message }));
        toast.error(message);
        return;
      }

      const data = (await res.json()) as DeleteDocumentResponse;
      uploadOrchestrator.removeDocument(batchId, doc.id);
      if (previewDoc?.id === doc.id) {
        setPreviewDoc(null);
      }
      if (activeReviewDocId === doc.id) {
        setReviewDocId(null);
      }
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        return {
          status: "ready",
          data: {
            batch: data.batch,
            documents: prev.data.documents.filter((item) => item.id !== doc.id),
          },
        };
      });
      setPendingFocusTarget(
        nextFocusDocId ? { type: "doc", docId: nextFocusDocId } : { type: "section" },
      );
      toast.success("Document removed");
    } catch {
      const message = "Network error while removing document. Please retry.";
      setDocAccessErrors((prev) => ({ ...prev, [doc.id]: message }));
      toast.error(message);
    } finally {
      setDeletingDocIds((prev) => {
        const next = { ...prev };
        delete next[doc.id];
        return next;
      });
    }
  }

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
        <p role="status" aria-live="polite" className="mt-4 text-[14px] text-muted-foreground">
          Loading batch from workspace…
        </p>
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
              {state.unauthorized ? (
                <Button variant="ink" asChild>
                  <Link
                    to="/login"
                    search={{ verified: undefined, email: undefined, error: undefined }}
                  >
                    Sign in
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void loadBatch()}>
                  <RefreshCw className="size-4" /> Retry
                </Button>
              )}
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
  const uploadedDocs = documents.filter((doc) => doc.status === "uploaded");
  const uploadedCount = uploadedDocs.length;
  const verifiedCount = uploadedDocs.filter((doc) => doc.reviewStatus === "verified").length;
  const awaitingReviewCount = uploadedDocs.filter(
    (doc) => doc.reviewStatus === null || doc.reviewStatus === "needs_review",
  ).length;
  const activeReviewDoc = activeReviewDocId
    ? (uploadedDocs.find((doc) => doc.id === activeReviewDocId) ?? null)
    : null;
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

  const docRows = documents.map((doc) => {
    const entry: DocumentUploadEntry | undefined = uploadEntries.get(doc.id);
    const isLocallyUploading = entry?.phase === "uploading";
    const isLocallyQueued = entry?.phase === "queued";
    const isLocallyCancelling = entry?.phase === "cancelling";
    const isCancelUnconfirmed = entry?.phase === "cancel_unconfirmed";
    const effectiveStatus: DocumentUploadStatus =
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
    return {
      doc,
      entry,
      isLocallyUploading,
      isLocallyQueued,
      isLocallyCancelling,
      isCancelUnconfirmed,
      effectiveStatus,
    };
  });

  const normalizedDocQuery = docQuery.trim().toLowerCase();
  const visibleDocRows = docRows.filter(({ doc, effectiveStatus }) => {
    if (docFilter !== "all" && effectiveStatus !== docFilter) return false;
    if (reviewFilter !== "all") {
      if (doc.status !== "uploaded") return false;
      const docReviewState: EffectiveDocumentReviewState = doc.reviewStatus ?? "unreviewed";
      if (docReviewState !== reviewFilter) return false;
    }
    if (normalizedDocQuery) {
      return `${doc.originalFilename} ${doc.id}`.toLowerCase().includes(normalizedDocQuery);
    }
    return true;
  });

  function handleExportBatchCsv() {
    if (documents.length === 0) return;
    const csv = persistedDocumentsToCsv(
      documents.map((doc) => ({
        ...doc,
        batchName: batch.name,
      })),
    );
    const slug =
      batch.name
        .replace(/\W+/g, "-")
        .toLowerCase()
        .replace(/^-+|-+$/g, "") || "batch";
    const datePart = new Date().toISOString().slice(0, 10);
    downloadCsv(`gathr_${slug}_${datePart}.csv`, csv);
    toast.success(
      `Exported ${documents.length} document record${documents.length === 1 ? "" : "s"}`,
    );
  }

  const docFilterOptions: { value: DocFilter; label: string; count: number }[] = (
    ["all", "uploaded", "uploading", "pending_upload", "failed"] as DocFilter[]
  ).map((value) => ({
    value,
    label: {
      all: "All",
      uploaded: "Uploaded",
      uploading: "Uploading",
      pending_upload: "Pending",
      failed: "Failed",
    }[value],
    count:
      value === "all"
        ? docRows.length
        : docRows.filter((item) => item.effectiveStatus === value).length,
  }));

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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isDeleting || isFinalizing}
            aria-busy={isRefreshing}
            onClick={() => void loadBatch()}
            aria-label="Reload batch from server"
          >
            <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} />{" "}
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
          {documents.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportBatchCsv}
              aria-label="Export batch CSV"
            >
              <Download className="size-3.5" /> Export CSV
            </Button>
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
          {uploadedCount > 0
            ? ` · ${verifiedCount} verified · ${awaitingReviewCount} awaiting review`
            : ""}
        </span>
      </div>

      {documents.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No documents in this batch." />
        </div>
      ) : (
        <section className="mt-8" aria-label="Prepared PDF documents">
          <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <h2
              ref={sectionHeadingRef}
              tabIndex={-1}
              className="eyebrow outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Documents ({documents.length})
            </h2>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <FilterTabs value={docFilter} onChange={setDocFilter} options={docFilterOptions} />
              <select
                value={reviewFilter}
                onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}
                aria-label="Filter by review status"
                className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground focus:border-primary focus:outline-none"
              >
                <option value="all">All review states</option>
                <option value="unreviewed">Unreviewed</option>
                {DOCUMENT_REVIEW_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {formatReviewStatusLabel(st)}
                  </option>
                ))}
              </select>
              <div className="relative sm:w-56">
                <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={docQuery}
                  onChange={(e) => setDocQuery(e.target.value)}
                  placeholder="Find document"
                  aria-label="Filter documents in batch"
                  className="h-8 bg-surface pl-8 text-[12.5px]"
                />
              </div>
            </div>
          </div>

          {visibleDocRows.length === 0 ? (
            <EmptyState
              title="No matching documents."
              action={
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDocQuery("");
                    setDocFilter("all");
                    setReviewFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              }
            >
              Try a different filename, document ID, upload status, or review status filter.
            </EmptyState>
          ) : (
            <ul className="border-t border-foreground">
              {visibleDocRows.map(
                (
                  {
                    doc,
                    entry,
                    isLocallyUploading,
                    isLocallyQueued,
                    isLocallyCancelling,
                    isCancelUnconfirmed,
                    effectiveStatus,
                  },
                  idx,
                ) => {
                  const uploadInlineError =
                    reattachErrors[doc.id] ??
                    (doc.status !== "uploaded" ? (entry?.errorMessage ?? doc.errorMessage) : null);
                  const accessError = docAccessErrors[doc.id] ?? null;
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
                  const canDeleteDocument =
                    !isFinalized &&
                    !isLocallyUploading &&
                    !isLocallyQueued &&
                    !isLocallyCancelling &&
                    !isStrandedServerUpload;
                  const nextFocusDocId =
                    visibleDocRows[idx + 1]?.doc.id ?? visibleDocRows[idx - 1]?.doc.id ?? null;

                  return (
                    <li
                      key={doc.id}
                      ref={(el) => {
                        rowRefs.current[doc.id] = el;
                      }}
                      className="flex flex-col gap-3 border-b border-border py-4"
                      data-document-id={doc.id}
                      data-upload-status={effectiveStatus}
                      data-review-status={
                        doc.status === "uploaded" ? (doc.reviewStatus ?? "unreviewed") : "pending"
                      }
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
                            <p className="truncate text-[14px] font-medium">
                              {doc.originalFilename}
                            </p>
                            <p className="num mt-0.5 text-[11px] text-muted-foreground">
                              {doc.id} · {formatBytes(doc.fileSizeBytes)} · {doc.mimeType}
                            </p>
                            {isLocallyQueued && doc.status !== "uploaded" && (
                              <p className="num mt-1 text-[11.5px] text-muted-foreground">
                                Queued — waiting for an open upload slot (max{" "}
                                {MAX_CONCURRENT_UPLOADS} concurrent)
                              </p>
                            )}
                            {uploadInlineError && (
                              <p role="alert" className="mt-1 text-[12px] text-destructive">
                                {uploadInlineError}
                              </p>
                            )}
                            {accessError && (
                              <div
                                role="alert"
                                className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-destructive"
                              >
                                <span>{accessError}</span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-[11.5px]"
                                  onClick={() =>
                                    setDocAccessErrors((prev) => {
                                      const next = { ...prev };
                                      delete next[doc.id];
                                      return next;
                                    })
                                  }
                                >
                                  Dismiss
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <DocumentUploadStatusPill status={effectiveStatus} />
                          {doc.status === "uploaded" && (
                            <DocumentReviewStatusPill status={doc.reviewStatus} />
                          )}

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
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label={`View ${doc.originalFilename}`}
                                onClick={(e) => {
                                  previewOpenerRef.current = e.currentTarget;
                                  setPreviewDoc(doc);
                                }}
                              >
                                <Eye className="size-3.5" /> View PDF
                              </Button>
                              <Button
                                type="button"
                                variant="default"
                                size="sm"
                                aria-label={`Review ${doc.originalFilename}`}
                                onClick={(e) => {
                                  reviewOpenerRef.current = e.currentTarget;
                                  setReviewDocId(doc.id);
                                }}
                              >
                                <ClipboardCheck className="size-3.5" /> Review
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={Boolean(downloadingDocIds[doc.id])}
                                aria-label={`Download ${doc.originalFilename}`}
                                onClick={() => void handleDownloadDocument(doc)}
                              >
                                <Download className="size-3.5" />{" "}
                                {downloadingDocIds[doc.id] ? "Downloading…" : "Download"}
                              </Button>
                            </>
                          )}

                          {canDeleteDocument && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={
                                Boolean(deletingDocIds[doc.id]) || isDeleting || isFinalizing
                              }
                              aria-label={`Delete ${doc.originalFilename}`}
                              onClick={(e) => {
                                deleteConfirmedRef.current = false;
                                deleteOpenerRef.current = e.currentTarget;
                                setPendingDocDelete({ doc, nextFocusDocId });
                              }}
                            >
                              <Trash2 className="size-3.5" />{" "}
                              {deletingDocIds[doc.id] ? "Removing…" : "Delete"}
                            </Button>
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
                },
              )}
            </ul>
          )}
        </section>
      )}

      <DocumentPreviewDialog
        document={previewDoc}
        open={Boolean(previewDoc)}
        onOpenChange={(open) => {
          if (!open) setPreviewDoc(null);
        }}
        onDownload={(doc) => void handleDownloadDocument(doc)}
        onRefreshBatch={() => void loadBatch()}
        returnFocusTo={previewOpenerRef.current}
      />

      <PersistedDocumentReviewDialog
        document={activeReviewDoc}
        batch={batch}
        uploadedDocuments={uploadedDocs}
        open={Boolean(activeReviewDoc)}
        onOpenChange={(open) => {
          if (!open) setReviewDocId(null);
        }}
        onSelectDocument={(nextDoc) => setReviewDocId(nextDoc.id)}
        onDocumentUpdated={(updatedDoc, updatedBatch) =>
          handleServerUpdate({
            document: updatedDoc,
            batch: updatedBatch ?? batch,
          })
        }
        onDownload={(doc) => void handleDownloadDocument(doc)}
        onRefreshBatch={() => void loadBatch()}
        returnFocusTo={reviewOpenerRef.current}
      />

      <AlertDialog
        open={Boolean(pendingDocDelete)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDocDelete(null);
            if (!deleteConfirmedRef.current && deleteOpenerRef.current?.isConnected) {
              const opener = deleteOpenerRef.current;
              setTimeout(() => opener.focus(), 0);
            }
          }
        }}
      >
        <AlertDialogContent className="rounded-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-2xl font-normal">
              {pendingDocDelete
                ? `Remove ${pendingDocDelete.doc.originalFilename}?`
                : "Remove document?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the document record from this batch and schedules any stored PDF object
              for cleanup. Removing a document does not mark it approved or rejected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!pendingDocDelete) return;
                deleteConfirmedRef.current = true;
                const target = pendingDocDelete;
                setPendingDocDelete(null);
                void handleDeleteDocument(target.doc, target.nextFocusDocId);
              }}
            >
              Remove document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
