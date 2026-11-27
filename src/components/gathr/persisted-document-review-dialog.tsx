import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Flag,
  RefreshCw,
  RotateCcw,
  SkipForward,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/gathr/common";
import { PrivatePdfPreviewPane } from "@/components/gathr/document-preview-dialog";
import { DocumentReviewStatusPill, DocumentUploadStatusPill } from "@/components/gathr/status";
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
  formatReviewStatusLabel,
  getAvailableReviewActions,
  type DocumentDetailResponse,
  type DocumentReviewEvent,
  type DocumentReviewStatus,
  type PersistedBatch,
  type PersistedDocument,
} from "@/lib/gathr/ingestion-types";
import { submitDocumentReviewDecision } from "@/lib/gathr/review-client";
import { cn } from "@/lib/utils";

interface ReviewErrorState {
  kind: "conflict" | "unauthorized" | "not_found" | "error";
  message: string;
  retryStatus?: DocumentReviewStatus | undefined;
}

export function PersistedDocumentReviewDialog({
  document: initialDoc,
  batch: initialBatch,
  uploadedDocuments,
  open,
  onOpenChange,
  onSelectDocument,
  onDocumentUpdated,
  onDownload,
  onRefreshBatch,
  returnFocusTo,
}: {
  document: PersistedDocument | null;
  batch: PersistedBatch | null;
  uploadedDocuments: PersistedDocument[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectDocument: (doc: PersistedDocument) => void;
  onDocumentUpdated: (doc: PersistedDocument, batch?: PersistedBatch) => void;
  onDownload: (doc: PersistedDocument) => void;
  onRefreshBatch?: (() => void) | undefined;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const [liveDoc, setLiveDoc] = useState<PersistedDocument | null>(initialDoc);
  const [liveBatch, setLiveBatch] = useState<PersistedBatch | null>(initialBatch);
  const [reviewEvents, setReviewEvents] = useState<DocumentReviewEvent[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [submittingAction, setSubmittingAction] = useState<DocumentReviewStatus | null>(null);
  const [reviewError, setReviewError] = useState<ReviewErrorState | null>(null);
  const [mobileTab, setMobileTab] = useState<"pdf" | "review">("review");

  const openerRef = useRef<HTMLElement | null>(null);
  const detailSeqRef = useRef(0);
  const activeDetailControllerRef = useRef<AbortController | null>(null);
  const onDocumentUpdatedRef = useRef(onDocumentUpdated);
  onDocumentUpdatedRef.current = onDocumentUpdated;
  const intentKeyRef = useRef<{
    docId: string;
    targetStatus: DocumentReviewStatus;
    key: string;
  } | null>(null);

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

  useEffect(() => {
    setLiveDoc((prev) => {
      if (
        prev &&
        initialDoc &&
        prev.id === initialDoc.id &&
        (prev.reviewVersion ?? 0) > (initialDoc.reviewVersion ?? 0)
      ) {
        return prev;
      }
      return initialDoc;
    });
    setLiveBatch(initialBatch);
  }, [initialDoc, initialBatch]);

  const loadDocumentDetail = useCallback(async (docId: string) => {
    const seq = ++detailSeqRef.current;
    activeDetailControllerRef.current?.abort();
    const controller = new AbortController();
    activeDetailControllerRef.current = controller;
    setLoadingDetail(true);

    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(docId)}`, {
        method: "GET",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (controller.signal.aborted || seq !== detailSeqRef.current) return;

      if (!res.ok) {
        if (res.status === 401) {
          setReviewError({
            kind: "unauthorized",
            message: "Your session has expired. Sign in again to review this document.",
          });
        } else if (res.status === 404) {
          setReviewError({
            kind: "not_found",
            message: "This document no longer exists in your workspace.",
          });
        }
        setLoadingDetail(false);
        return;
      }

      const data = (await res.json()) as DocumentDetailResponse;
      if (controller.signal.aborted || seq !== detailSeqRef.current) return;
      setLiveDoc(data.document);
      setLiveBatch(data.batch);
      setReviewEvents(Array.isArray(data.reviewEvents) ? data.reviewEvents : []);
      onDocumentUpdatedRef.current(data.document, data.batch);
      setLoadingDetail(false);
    } catch (err) {
      if (
        controller.signal.aborted ||
        seq !== detailSeqRef.current ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return;
      }
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !initialDoc) {
      activeDetailControllerRef.current?.abort();
      setReviewEvents([]);
      setReviewError(null);
      setSubmittingAction(null);
      intentKeyRef.current = null;
      return;
    }
    setReviewEvents([]);
    setReviewError(null);
    setSubmittingAction(null);
    intentKeyRef.current = null;
    void loadDocumentDetail(initialDoc.id);
    return () => {
      activeDetailControllerRef.current?.abort();
    };
  }, [open, initialDoc?.id, loadDocumentDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  const doc = liveDoc ?? initialDoc;
  const batch = liveBatch ?? initialBatch;

  const uploadedIndex = doc ? uploadedDocuments.findIndex((item) => item.id === doc.id) : -1;
  const prevDoc = uploadedIndex > 0 ? uploadedDocuments[uploadedIndex - 1]! : null;
  const nextDoc =
    uploadedIndex >= 0 && uploadedIndex < uploadedDocuments.length - 1
      ? uploadedDocuments[uploadedIndex + 1]!
      : null;

  const availableActions = doc ? getAvailableReviewActions(doc.status, doc.reviewStatus) : [];

  async function handleReviewAction(targetStatus: DocumentReviewStatus, isRetry = false) {
    if (!doc || submittingAction !== null || doc.status !== "uploaded") return;

    // Cancel any in-flight background detail refresh so stale GETs cannot overwrite mutation state.
    detailSeqRef.current += 1;
    activeDetailControllerRef.current?.abort();
    setLoadingDetail(false);

    const currentIntent = intentKeyRef.current;
    const idempotencyKey =
      isRetry &&
      currentIntent &&
      currentIntent.docId === doc.id &&
      currentIntent.targetStatus === targetStatus
        ? currentIntent.key
        : globalThis.crypto.randomUUID();

    intentKeyRef.current = { docId: doc.id, targetStatus, key: idempotencyKey };
    setSubmittingAction(targetStatus);
    setReviewError(null);

    const result = await submitDocumentReviewDecision({
      documentId: doc.id,
      reviewStatus: targetStatus,
      expectedReviewStatus: doc.reviewStatus,
      expectedReviewVersion: doc.reviewVersion ?? 0,
      idempotencyKey,
    });

    setSubmittingAction(null);

    if (result.ok) {
      intentKeyRef.current = null;
      setLiveDoc(result.data.document);
      setLiveBatch(result.data.batch);
      setReviewEvents(result.data.reviewEvents ?? []);
      onDocumentUpdated(result.data.document, result.data.batch);
      const label = formatReviewStatusLabel(result.data.document.reviewStatus);
      toast.success(
        result.data.alreadyInState
          ? `${result.data.document.originalFilename} is already ${label}`
          : `${result.data.document.originalFilename} marked ${label}`,
      );
      return;
    }

    if (result.kind === "conflict") {
      intentKeyRef.current = null;
      if (result.currentDocument) {
        setLiveDoc(result.currentDocument);
        onDocumentUpdated(result.currentDocument, batch ?? undefined);
      }
      void loadDocumentDetail(doc.id);
      setReviewError({
        kind: "conflict",
        message: result.message,
      });
      toast.error("Document review state changed elsewhere. Refreshed latest state.");
      return;
    }

    if (result.kind === "unauthorized" || result.kind === "not_found") {
      intentKeyRef.current = null;
      setReviewError({
        kind: result.kind,
        message: result.message,
      });
      toast.error(result.message);
      return;
    }

    setReviewError({
      kind: "error",
      message: result.message,
      retryStatus: targetStatus,
    });
    toast.error(result.message);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[92vh] max-w-6xl flex-col gap-4 overflow-hidden"
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo ?? openerRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader className="pr-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <FileText className="mt-1 size-4 shrink-0 text-muted-foreground" strokeWidth={1.6} />
              <div className="min-w-0">
                <DialogTitle className="truncate font-serif text-2xl font-normal">
                  {doc?.originalFilename ?? "Document review"}
                </DialogTitle>
                {doc && (
                  <DialogDescription className="num mt-1 text-[11.5px] text-muted-foreground">
                    {batch ? `${batch.name} · ` : ""}
                    {doc.id} · {formatBytes(doc.fileSizeBytes)}
                  </DialogDescription>
                )}
              </div>
            </div>
            {doc && uploadedDocuments.length > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!prevDoc || submittingAction !== null}
                  aria-label="Previous uploaded document"
                  onClick={() => prevDoc && onSelectDocument(prevDoc)}
                >
                  <ChevronLeft className="size-3.5" /> Prev
                </Button>
                <span className="num px-2 text-[11.5px] text-muted-foreground">
                  {uploadedIndex >= 0 ? `${uploadedIndex + 1} / ${uploadedDocuments.length}` : "—"}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!nextDoc || submittingAction !== null}
                  aria-label="Next uploaded document"
                  onClick={() => nextDoc && onSelectDocument(nextDoc)}
                >
                  Next <ChevronRight className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>

        {/* Mobile view switch */}
        <div className="grid grid-cols-2 border-y border-border lg:hidden">
          {(["review", "pdf"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setMobileTab(t)}
              className={cn(
                "py-2 text-[13px]",
                mobileTab === t
                  ? "border-b-2 border-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              {t === "review" ? "Review & status" : "PDF document"}
            </button>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 gap-5 overflow-hidden lg:grid-cols-[minmax(0,1.3fr)_minmax(340px,420px)]">
          {/* Left: real private PDF stream */}
          <div
            className={cn(
              "min-h-0 flex-col overflow-hidden lg:flex",
              mobileTab === "pdf" ? "flex" : "hidden",
            )}
          >
            <PrivatePdfPreviewPane
              document={doc}
              active={open}
              onDownload={onDownload}
              onRefreshBatch={onRefreshBatch}
              iframeClassName="h-[52vh] lg:h-[62vh]"
            />
          </div>

          {/* Right: captured metadata + explicit human decision panel */}
          <div
            className={cn(
              "min-h-0 flex-col overflow-y-auto border-border pr-1 lg:flex lg:border-l lg:pl-5",
              mobileTab === "review" ? "flex" : "hidden",
            )}
          >
            {doc && (
              <div className="flex flex-1 flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3.5 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <DocumentUploadStatusPill status={doc.status} />
                    {doc.status === "uploaded" && (
                      <DocumentReviewStatusPill status={doc.reviewStatus} />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="num text-[11px] text-muted-foreground">
                      v{doc.reviewVersion ?? 0}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11.5px]"
                      disabled={loadingDetail || submittingAction !== null}
                      onClick={() => void loadDocumentDetail(doc.id)}
                      aria-label="Refresh document review state"
                    >
                      <RefreshCw className={cn("size-3", loadingDetail && "animate-spin")} />{" "}
                      Refresh
                    </Button>
                  </div>
                </div>

                {reviewError && (
                  <div
                    role="alert"
                    className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[12.5px] text-destructive"
                  >
                    <div className="flex items-start gap-2">
                      <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      <p>{reviewError.message}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 pl-6">
                      {reviewError.kind === "unauthorized" ? (
                        <Button variant="ink" size="sm" asChild>
                          <Link
                            to="/login"
                            search={{ verified: undefined, email: undefined, error: undefined }}
                          >
                            Sign in
                          </Link>
                        </Button>
                      ) : reviewError.kind === "conflict" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setReviewError(null);
                            void loadDocumentDetail(doc.id);
                          }}
                        >
                          Reload latest state
                        </Button>
                      ) : reviewError.retryStatus ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={submittingAction !== null}
                          onClick={() =>
                            reviewError.retryStatus &&
                            void handleReviewAction(reviewError.retryStatus, true)
                          }
                        >
                          Retry decision
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setReviewError(null)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                )}

                <div className="rounded-md border border-border bg-surface px-3.5 py-2.5 text-[12px] text-muted-foreground">
                  Human review only — GATHR records document identity and explicit approval
                  decisions. No invoice fields are extracted automatically, and approval does not
                  verify tax, vendor, or accounting compliance.
                </div>

                <dl className="divide-y divide-border border-y border-border text-[12.5px]">
                  <div className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-muted-foreground">Filename</dt>
                    <dd className="max-w-[230px] truncate text-right font-medium">
                      {doc.originalFilename}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-muted-foreground">Batch</dt>
                    <dd className="max-w-[230px] truncate text-right">
                      {batch?.name ?? doc.batchId}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-muted-foreground">File size</dt>
                    <dd className="num text-right">{formatBytes(doc.fileSizeBytes)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-muted-foreground">MIME type</dt>
                    <dd className="num text-right">{doc.mimeType}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-muted-foreground">Uploaded</dt>
                    <dd className="num text-right">
                      {doc.uploadedAt ? formatDate(doc.uploadedAt) : "Not uploaded"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-muted-foreground">Review decision</dt>
                    <dd className="num text-right">
                      {doc.reviewUpdatedAt ? formatDate(doc.reviewUpdatedAt) : "Awaiting decision"}
                    </dd>
                  </div>
                </dl>

                {/* Explicit decision actions */}
                {doc.status !== "uploaded" ? (
                  <div className="rounded-md border border-border bg-secondary px-3.5 py-3 text-[12.5px] text-muted-foreground">
                    Upload must complete before this document can enter human review.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <p className="eyebrow">Review decision</p>

                    {availableActions.includes("verified") ? (
                      <>
                        <Button
                          type="button"
                          variant="default"
                          className="w-full"
                          disabled={submittingAction !== null}
                          onClick={() => void handleReviewAction("verified")}
                        >
                          <Check className="size-4" />{" "}
                          {submittingAction === "verified" ? "Saving…" : "Approve document"}
                        </Button>
                        <div className="grid grid-cols-2 gap-2">
                          {availableActions.includes("needs_review") && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={submittingAction !== null}
                              onClick={() => void handleReviewAction("needs_review")}
                            >
                              <Flag className="size-3.5" />{" "}
                              {submittingAction === "needs_review" ? "Saving…" : "Needs review"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={submittingAction !== null}
                            onClick={() => void handleReviewAction("skipped")}
                          >
                            <SkipForward className="size-3.5" />{" "}
                            {submittingAction === "skipped" ? "Saving…" : "Skip"}
                          </Button>
                          <ConfirmDialog
                            trigger={
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={submittingAction !== null}
                              >
                                <Copy className="size-3.5" />{" "}
                                {submittingAction === "duplicate" ? "Saving…" : "Mark duplicate"}
                              </Button>
                            }
                            title="Mark document as duplicate?"
                            description="This records the document as a duplicate in your workspace. The stored PDF remains available and can be returned to review later."
                            confirmLabel="Mark duplicate"
                            destructive
                            onConfirm={() => void handleReviewAction("duplicate")}
                          />
                          <ConfirmDialog
                            trigger={
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={submittingAction !== null}
                              >
                                <Ban className="size-3.5" />{" "}
                                {submittingAction === "rejected" ? "Saving…" : "Reject"}
                              </Button>
                            }
                            title="Reject this document?"
                            description="This records a business rejection on the uploaded PDF without deleting the file. You can return it to review later if needed."
                            confirmLabel="Reject document"
                            destructive
                            onConfirm={() => void handleReviewAction("rejected")}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-[12px] text-muted-foreground">
                          Decision recorded ({formatReviewStatusLabel(doc.reviewStatus)}). Return to
                          review before choosing a different outcome.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full"
                          disabled={submittingAction !== null}
                          onClick={() => void handleReviewAction("needs_review")}
                        >
                          <RotateCcw className="size-3.5" />{" "}
                          {submittingAction === "needs_review" ? "Saving…" : "Return to review"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <details className="mt-auto border-t border-border pt-3 text-[12px] text-muted-foreground">
                  <summary className="cursor-pointer font-medium text-foreground">
                    Review history ({reviewEvents.length})
                  </summary>
                  {reviewEvents.length === 0 ? (
                    <p className="mt-2 text-[11.5px] text-muted-foreground">
                      No review decisions recorded yet.
                    </p>
                  ) : (
                    <ul className="num mt-2 space-y-1.5">
                      {reviewEvents.map((ev) => (
                        <li
                          key={ev.id}
                          className="rounded-sm border border-border bg-surface px-2.5 py-1.5 text-[11px]"
                        >
                          <div className="flex items-center justify-between gap-2 text-foreground">
                            <span>
                              {formatReviewStatusLabel(ev.fromReviewStatus)} →{" "}
                              {formatReviewStatusLabel(ev.toReviewStatus)}
                            </span>
                            <span className="text-muted-foreground">{ev.actorName}</span>
                          </div>
                          <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                            {formatDate(ev.createdAt)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
