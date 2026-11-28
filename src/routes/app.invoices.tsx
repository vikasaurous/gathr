import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  Ban,
  Check,
  Copy,
  Download,
  Flag,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, EmptyState, FilterTabs, PageHeader } from "@/components/gathr/common";
import { PersistedExportDialog } from "@/components/gathr/persisted-export-dialog";
import { DocumentReviewStatusPill, DocumentUploadStatusPill } from "@/components/gathr/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatBytes, formatDate } from "@/lib/gathr/format";
import {
  DOCUMENT_REVIEW_STATUSES,
  formatReviewStatusLabel,
  getAvailableReviewActions,
  type BatchListResponse,
  type DocumentDetailResponse,
  type DocumentListResponse,
  type DocumentReviewEvent,
  type DocumentReviewStatus,
  type EffectiveDocumentReviewState,
  type WorkspaceDocumentListItem,
  type WorkspaceDocumentReviewCounts,
} from "@/lib/gathr/ingestion-types";
import {
  setPendingReviewBadgeCount,
  submitDocumentReviewDecision,
} from "@/lib/gathr/review-client";

export const Route = createFileRoute("/app/invoices")({
  head: () => ({
    meta: [
      { title: "Documents & Review | gathr" },
      {
        name: "description",
        content: "Search uploaded invoice PDFs and track review decisions across your workspace.",
      },
      { property: "og:title", content: "Documents & Review — gathr" },
      {
        property: "og:description",
        content: "Search uploaded invoice PDFs and track review decisions across your workspace.",
      },
    ],
  }),
  component: Invoices,
});

type ReviewTabFilter = "all" | EffectiveDocumentReviewState;

const EMPTY_COUNTS: WorkspaceDocumentReviewCounts = {
  total: 0,
  uploaded: 0,
  unreviewed: 0,
  needsReview: 0,
  verified: 0,
  duplicate: 0,
  rejected: 0,
  skipped: 0,
};

export function Invoices() {
  const [documents, setDocuments] = useState<WorkspaceDocumentListItem[]>([]);
  const [counts, setCounts] = useState<WorkspaceDocumentReviewCounts>(EMPTY_COUNTS);
  const [filteredTotal, setFilteredTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [batchOptionsList, setBatchOptionsList] = useState<Array<[string, string]>>([]);

  const [reviewFilter, setReviewFilter] = useState<ReviewTabFilter>("all");
  const [q, setQ] = useState("");
  const [batchFilter, setBatchFilter] = useState("all");

  const [openDoc, setOpenDoc] = useState<WorkspaceDocumentListItem | null>(null);
  const [openEvents, setOpenEvents] = useState<DocumentReviewEvent[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [submittingAction, setSubmittingAction] = useState<DocumentReviewStatus | null>(null);
  const [actionError, setActionError] = useState<{
    kind: "unauthorized" | "conflict" | "not_found" | "error";
    message: string;
    retryStatus?: DocumentReviewStatus | undefined;
  } | null>(null);

  const loadSeqRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const detailSeqRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);
  const workspaceTruncatedRef = useRef(false);
  const serverFilterActiveRef = useRef(false);
  const didMountFilterRef = useRef(false);
  const activeFiltersRef = useRef<{
    reviewFilter: ReviewTabFilter;
    batchFilter: string;
    q: string;
  }>({ reviewFilter: "all", batchFilter: "all", q: "" });
  activeFiltersRef.current = { reviewFilter, batchFilter, q };

  const intentKeyRef = useRef<{
    docId: string;
    targetStatus: DocumentReviewStatus;
    expectedVersion: number;
    key: string;
  } | null>(null);

  const loadDocuments = useCallback(
    async (options?: {
      externalSignal?: AbortSignal;
      offset?: number;
      append?: boolean;
      reviewStatus?: ReviewTabFilter;
      batchId?: string;
      searchQuery?: string;
    }) => {
      const seq = ++loadSeqRef.current;
      activeControllerRef.current?.abort();
      const localController = new AbortController();
      activeControllerRef.current = localController;
      const externalSignal = options?.externalSignal;
      const onExternalAbort = () => localController.abort();
      if (externalSignal) {
        if (externalSignal.aborted) {
          localController.abort();
        } else {
          externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }
      const signal = localController.signal;
      const append = Boolean(options?.append);
      const offset = options?.offset ?? 0;

      const params = new URLSearchParams({ limit: "200" });
      if (offset > 0) params.set("offset", String(offset));
      if (options?.reviewStatus && options.reviewStatus !== "all") {
        params.set("reviewStatus", options.reviewStatus);
      }
      if (options?.batchId && options.batchId !== "all") {
        params.set("batchId", options.batchId);
      }
      if (options?.searchQuery?.trim()) {
        params.set("q", options.searchQuery.trim());
      }

      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setLoadError(null);
      setAuthExpired(false);

      try {
        const docsPromise = fetch(`/api/documents?${params.toString()}`, {
          method: "GET",
          credentials: "same-origin",
          signal,
        });
        const batchesPromise =
          !append && offset === 0
            ? fetch("/api/batches?limit=100", {
                method: "GET",
                credentials: "same-origin",
                signal,
              }).catch(() => null)
            : Promise.resolve(null);

        const [res, batchesRes] = await Promise.all([docsPromise, batchesPromise]);
        if (signal.aborted || seq !== loadSeqRef.current) return;

        if (res.status === 401) {
          setAuthExpired(true);
          setLoadError(
            "Your session has expired. Please sign in again to view workspace documents.",
          );
          setLoading(false);
          setLoadingMore(false);
          return;
        }

        if (!res.ok) {
          let message = "Could not load workspace documents.";
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body.error === "string" && body.error) message = body.error;
          } catch {
            // Keep safe fallback message
          }
          if (signal.aborted || seq !== loadSeqRef.current) return;
          setLoadError(message);
          setLoading(false);
          setLoadingMore(false);
          return;
        }

        const data = (await res.json()) as DocumentListResponse;
        if (signal.aborted || seq !== loadSeqRef.current) return;

        if (batchesRes && batchesRes.ok) {
          try {
            const batchData = (await batchesRes.json()) as BatchListResponse;
            if (!signal.aborted && Array.isArray(batchData.batches)) {
              setBatchOptionsList(batchData.batches.map((b) => [b.id, b.name]));
            }
          } catch {
            // Fall back to batches derived from loaded documents
          }
        }

        const list = Array.isArray(data.documents) ? data.documents : [];
        const nextCounts = data.counts ?? EMPTY_COUNTS;
        const resolvedTotal = data.filteredTotal ?? nextCounts.total;
        const resolvedHasMore =
          data.hasMore !== undefined ? data.hasMore : offset + list.length < resolvedTotal;

        if (!options?.reviewStatus && !options?.batchId && !options?.searchQuery && offset === 0) {
          workspaceTruncatedRef.current = resolvedHasMore || nextCounts.total > list.length;
        }

        setDocuments((prev) => {
          if (!append) return list;
          const seen = new Set(prev.map((d) => d.id));
          return [...prev, ...list.filter((d) => !seen.has(d.id))];
        });
        setCounts(nextCounts);
        setFilteredTotal(resolvedTotal);
        setHasMore(resolvedHasMore);
        setPendingReviewBadgeCount(nextCounts.unreviewed + nextCounts.needsReview);
        setLoading(false);
        setLoadingMore(false);
      } catch (err) {
        if (
          signal.aborted ||
          seq !== loadSeqRef.current ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        if (typeof window !== "undefined" && !window.location?.origin?.startsWith("http")) {
          setDocuments([]);
          setCounts(EMPTY_COUNTS);
          setFilteredTotal(0);
          setHasMore(false);
          setLoading(false);
          setLoadingMore(false);
          return;
        }
        setLoadError("Network error while loading workspace documents.");
        setLoading(false);
        setLoadingMore(false);
      } finally {
        externalSignal?.removeEventListener("abort", onExternalAbort);
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDocuments({ externalSignal: controller.signal });
    return () => {
      controller.abort();
      activeControllerRef.current?.abort();
    };
  }, [loadDocuments]);

  useEffect(() => {
    if (!didMountFilterRef.current) {
      didMountFilterRef.current = true;
      return;
    }
    const filtersActive = Boolean(q.trim() || batchFilter !== "all" || reviewFilter !== "all");
    if (!workspaceTruncatedRef.current && !serverFilterActiveRef.current) {
      return;
    }
    serverFilterActiveRef.current = filtersActive;
    const delayMs = q.trim() ? 180 : 0;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadDocuments({
        externalSignal: controller.signal,
        offset: 0,
        append: false,
        reviewStatus: reviewFilter,
        batchId: batchFilter,
        searchQuery: q,
      });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [reviewFilter, batchFilter, q, loadDocuments]);

  const loadSelectedDetail = useCallback(async (docId: string) => {
    const seq = ++detailSeqRef.current;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
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
          setActionError({
            kind: "unauthorized",
            message: "Your session has expired. Please sign in again to review documents.",
          });
        } else if (res.status === 404) {
          setActionError({
            kind: "not_found",
            message: "This document no longer exists in your workspace.",
          });
        }
        setLoadingDetail(false);
        return;
      }
      const data = (await res.json()) as DocumentDetailResponse;
      if (controller.signal.aborted || seq !== detailSeqRef.current) return;
      setOpenEvents(Array.isArray(data.reviewEvents) ? data.reviewEvents : []);
      setOpenDoc((prev) =>
        prev && prev.id === data.document.id ? { ...prev, ...data.document } : prev,
      );
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
    if (!openDoc) {
      detailControllerRef.current?.abort();
      setOpenEvents([]);
      setActionError(null);
      setSubmittingAction(null);
      intentKeyRef.current = null;
      return;
    }
    setActionError(null);
    setSubmittingAction(null);
    intentKeyRef.current = null;
    void loadSelectedDetail(openDoc.id);
    return () => {
      detailControllerRef.current?.abort();
    };
  }, [openDoc?.id, loadSelectedDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  const batches = useMemo(() => {
    const map = new Map<string, string>(batchOptionsList);
    for (const doc of documents) {
      if (!map.has(doc.batchId)) map.set(doc.batchId, doc.batchName);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [documents, batchOptionsList]);

  function reloadCurrentView() {
    const f = activeFiltersRef.current;
    return loadDocuments({
      offset: 0,
      append: false,
      ...(serverFilterActiveRef.current || workspaceTruncatedRef.current
        ? { reviewStatus: f.reviewFilter, batchId: f.batchFilter, searchQuery: f.q }
        : {}),
    });
  }

  const rows = useMemo(() => {
    const search = q.trim().toLowerCase();
    return documents.filter((doc) => {
      if (reviewFilter !== "all") {
        if (doc.status !== "uploaded") return false;
        const effective: EffectiveDocumentReviewState = doc.reviewStatus ?? "unreviewed";
        if (effective !== reviewFilter) return false;
      }
      if (batchFilter !== "all" && doc.batchId !== batchFilter) return false;
      if (search) {
        return `${doc.originalFilename} ${doc.id} ${doc.batchName} ${doc.batchId}`
          .toLowerCase()
          .includes(search);
      }
      return true;
    });
  }, [documents, reviewFilter, batchFilter, q]);

  const tabOptions: { value: ReviewTabFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.total },
    { value: "unreviewed", label: formatReviewStatusLabel(null), count: counts.unreviewed },
    ...DOCUMENT_REVIEW_STATUSES.map((st) => ({
      value: st,
      label: formatReviewStatusLabel(st),
      count:
        st === "needs_review"
          ? counts.needsReview
          : st === "verified"
            ? counts.verified
            : st === "duplicate"
              ? counts.duplicate
              : st === "rejected"
                ? counts.rejected
                : counts.skipped,
    })),
  ];

  async function handleSheetReviewAction(
    doc: WorkspaceDocumentListItem,
    targetStatus: DocumentReviewStatus,
  ) {
    if (submittingAction !== null || doc.status !== "uploaded") return;

    // Supersede any in-flight detail fetch so older GETs cannot overwrite mutation results.
    detailSeqRef.current += 1;
    detailControllerRef.current?.abort();
    setLoadingDetail(false);

    const expectedVersion = doc.reviewVersion ?? 0;
    const currentIntent = intentKeyRef.current;
    const idempotencyKey =
      currentIntent &&
      currentIntent.docId === doc.id &&
      currentIntent.targetStatus === targetStatus &&
      currentIntent.expectedVersion === expectedVersion
        ? currentIntent.key
        : globalThis.crypto.randomUUID();
    intentKeyRef.current = {
      docId: doc.id,
      targetStatus,
      expectedVersion,
      key: idempotencyKey,
    };

    setSubmittingAction(targetStatus);
    setActionError(null);

    const result = await submitDocumentReviewDecision({
      documentId: doc.id,
      reviewStatus: targetStatus,
      expectedReviewStatus: doc.reviewStatus,
      expectedReviewVersion: expectedVersion,
      idempotencyKey,
    });

    setSubmittingAction(null);

    if (result.ok) {
      intentKeyRef.current = null;
      const updated = { ...doc, ...result.data.document };
      setOpenDoc(updated);
      setOpenEvents(result.data.reviewEvents ?? []);
      setDocuments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(
        `${updated.originalFilename} marked ${formatReviewStatusLabel(updated.reviewStatus)}`,
      );
      void reloadCurrentView();
      return;
    }

    if (result.kind === "conflict") {
      intentKeyRef.current = null;
      if (result.currentDocument) {
        const conflicted = result.currentDocument;
        setOpenDoc((prev) =>
          prev && prev.id === conflicted.id ? { ...prev, ...conflicted } : prev,
        );
        setDocuments((prev) =>
          prev.map((item) => (item.id === conflicted.id ? { ...item, ...conflicted } : item)),
        );
      }
      setActionError({ kind: "conflict", message: result.message });
      void loadSelectedDetail(doc.id);
      void reloadCurrentView();
      return;
    }

    if (result.kind === "unauthorized" || result.kind === "not_found") {
      intentKeyRef.current = null;
      setActionError({ kind: result.kind, message: result.message });
      return;
    }

    setActionError({
      kind: "error",
      message: result.message,
      retryStatus: targetStatus,
    });
  }

  const hasFilters = Boolean(q.trim() || batchFilter !== "all" || reviewFilter !== "all");
  const openActions = openDoc
    ? getAvailableReviewActions(openDoc.status, openDoc.reviewStatus)
    : [];

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-8 md:px-10 md:py-12">
      <PageHeader
        eyebrow="Library"
        title="Invoices"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => void reloadCurrentView()}
              aria-label="Refresh documents"
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <PersistedExportDialog
              scope="workspace"
              batchId={batchFilter !== "all" ? batchFilter : undefined}
              label="Workspace documents"
              totalCount={counts.total}
              disabled={rows.length === 0 && counts.total === 0}
              defaultQuery={q}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  disabled={rows.length === 0 && counts.total === 0}
                  aria-label="Export documents"
                >
                  <Download className="size-4" /> Export
                </Button>
              }
            />
          </div>
        }
      >
        Every invoice gathered across your persisted workspace batches.
      </PageHeader>

      <div className="space-y-3 py-5">
        <FilterTabs value={reviewFilter} onChange={setReviewFilter} options={tabOptions} />
        <div className="grid gap-2 md:grid-cols-[1fr_240px_auto]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filename, document ID, or batch"
              aria-label="Search documents"
              className="bg-surface pl-9"
            />
          </div>
          <select
            value={batchFilter}
            onChange={(e) => setBatchFilter(e.target.value)}
            aria-label="Filter by batch"
            className="h-9 rounded-md border border-border bg-surface px-3 text-[13px] text-foreground focus:border-primary focus:outline-none"
          >
            <option value="all">All batches</option>
            {batches.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          {hasFilters && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setQ("");
                setBatchFilter("all");
                setReviewFilter("all");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <p role="status" aria-live="polite" className="py-12 text-[14px] text-muted-foreground">
          Loading workspace documents…
        </p>
      ) : loadError ? (
        <EmptyState
          title="Could not load documents."
          action={
            authExpired ? (
              <Button variant="ink" asChild>
                <Link
                  to="/login"
                  search={{ verified: undefined, email: undefined, error: undefined }}
                >
                  Sign in
                </Link>
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => void reloadCurrentView()}>
                <RefreshCw className="size-4" /> Retry
              </Button>
            )
          }
        >
          {loadError}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          title={hasFilters ? "No documents match." : "No invoice documents yet."}
          action={
            hasFilters ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setQ("");
                  setBatchFilter("all");
                  setReviewFilter("all");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button variant="ink" asChild>
                <Link to="/app/new">Upload documents</Link>
              </Button>
            )
          }
        >
          {hasFilters
            ? "Adjust your filters or upload a new batch."
            : "Create a batch and upload individual PDFs to begin human review."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13.5px]">
            <thead>
              <tr className="border-y border-foreground text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2.5 font-normal">Document</th>
                <th className="font-normal">Batch</th>
                <th className="font-normal">Upload status</th>
                <th className="font-normal">Review status</th>
                <th className="text-right font-normal">Size</th>
                <th className="pl-6 font-normal">Uploaded</th>
                <th className="text-right font-normal">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((doc) => (
                <tr
                  key={doc.id}
                  onClick={() => setOpenDoc(doc)}
                  className="cursor-pointer border-b border-border transition-colors hover:bg-surface"
                  data-document-id={doc.id}
                >
                  <td className="py-3 pr-4">
                    <p className="max-w-[280px] truncate font-medium">{doc.originalFilename}</p>
                    <p className="num text-[11px] text-muted-foreground">{doc.id}</p>
                  </td>
                  <td className="max-w-[200px] truncate pr-4 text-[12.5px] text-muted-foreground">
                    {doc.batchName}
                  </td>
                  <td className="pr-4">
                    <DocumentUploadStatusPill status={doc.status} />
                  </td>
                  <td className="pr-4">
                    {doc.status === "uploaded" ? (
                      <DocumentReviewStatusPill status={doc.reviewStatus} />
                    ) : (
                      <span className="num text-[11.5px] text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="num text-right text-[12px] text-muted-foreground">
                    {formatBytes(doc.fileSizeBytes)}
                  </td>
                  <td className="num pl-6 text-[12px] text-muted-foreground">
                    {formatDate(doc.uploadedAt ?? doc.createdAt)}
                  </td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setOpenDoc(doc)}
                    >
                      {doc.status === "uploaded" ? "Review" : "Inspect"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-[12.5px] text-muted-foreground">
              <span className="num">
                Showing {rows.length} of {filteredTotal ?? counts.total} document
                {(filteredTotal ?? counts.total) === 1 ? "" : "s"}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingMore || loading}
                onClick={() =>
                  void loadDocuments({
                    offset: documents.length,
                    append: true,
                    ...(serverFilterActiveRef.current || workspaceTruncatedRef.current
                      ? {
                          reviewStatus: reviewFilter,
                          batchId: batchFilter,
                          searchQuery: q,
                        }
                      : {}),
                  })
                }
              >
                {loadingMore ? "Loading more…" : "Load more documents"}
              </Button>
            </div>
          )}
        </div>
      )}

      <Sheet open={Boolean(openDoc)} onOpenChange={(o) => !o && setOpenDoc(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {openDoc && (
            <>
              <SheetHeader>
                <p className="num text-[11px] text-muted-foreground">{openDoc.id}</p>
                <SheetTitle className="break-words font-serif text-[26px] font-normal leading-tight">
                  {openDoc.originalFilename}
                </SheetTitle>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <DocumentUploadStatusPill status={openDoc.status} />
                  {openDoc.status === "uploaded" && (
                    <DocumentReviewStatusPill status={openDoc.reviewStatus} />
                  )}
                </div>
              </SheetHeader>

              <div className="mt-4 space-y-4 px-4">
                {actionError && (
                  <div
                    role="alert"
                    className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive"
                  >
                    <div className="flex items-start gap-2">
                      <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      <p>{actionError.message}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 pl-6">
                      {actionError.kind === "unauthorized" ? (
                        <Button variant="ink" size="sm" asChild>
                          <Link
                            to="/login"
                            search={{ verified: undefined, email: undefined, error: undefined }}
                          >
                            Sign in
                          </Link>
                        </Button>
                      ) : actionError.kind === "conflict" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setActionError(null);
                            void loadSelectedDetail(openDoc.id);
                          }}
                        >
                          Reload latest state
                        </Button>
                      ) : actionError.retryStatus ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={submittingAction !== null}
                          onClick={() =>
                            actionError.retryStatus &&
                            void handleSheetReviewAction(openDoc, actionError.retryStatus)
                          }
                        >
                          Retry decision
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setActionError(null)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                )}

                <p className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-muted-foreground">
                  GATHR tracks uploaded PDFs and explicit human review decisions only — no
                  unverified invoice fields are extracted or displayed.
                </p>

                <dl className="divide-y divide-border border-y border-border text-[12.5px]">
                  <div className="flex items-center justify-between gap-3 py-2.5">
                    <dt className="text-muted-foreground">Batch</dt>
                    <dd className="max-w-[220px] truncate text-right">{openDoc.batchName}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2.5">
                    <dt className="text-muted-foreground">File size</dt>
                    <dd className="num text-right">{formatBytes(openDoc.fileSizeBytes)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2.5">
                    <dt className="text-muted-foreground">MIME type</dt>
                    <dd className="num text-right">{openDoc.mimeType}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2.5">
                    <dt className="text-muted-foreground">Uploaded</dt>
                    <dd className="num text-right">
                      {openDoc.uploadedAt ? formatDate(openDoc.uploadedAt) : "Not uploaded"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2.5">
                    <dt className="text-muted-foreground">Last reviewed</dt>
                    <dd className="num text-right">
                      {openDoc.reviewUpdatedAt
                        ? formatDate(openDoc.reviewUpdatedAt)
                        : "Awaiting decision"}
                    </dd>
                  </div>
                </dl>

                {openDoc.status === "uploaded" ? (
                  <div className="space-y-2">
                    <p className="eyebrow">Review decision</p>
                    {openActions.includes("verified") ? (
                      <>
                        <Button
                          type="button"
                          variant="default"
                          className="w-full"
                          disabled={submittingAction !== null}
                          onClick={() => void handleSheetReviewAction(openDoc, "verified")}
                        >
                          <Check className="size-4" />{" "}
                          {submittingAction === "verified" ? "Saving…" : "Approve document"}
                        </Button>
                        <div className="grid grid-cols-2 gap-2">
                          {openActions.includes("needs_review") && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={submittingAction !== null}
                              onClick={() => void handleSheetReviewAction(openDoc, "needs_review")}
                            >
                              <Flag className="size-3.5" /> Needs review
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={submittingAction !== null}
                            onClick={() => void handleSheetReviewAction(openDoc, "skipped")}
                          >
                            <SkipForward className="size-3.5" /> Skip
                          </Button>
                          <ConfirmDialog
                            trigger={
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={submittingAction !== null}
                              >
                                <Copy className="size-3.5" /> Mark duplicate
                              </Button>
                            }
                            title="Mark document as duplicate?"
                            description="This flags the document as a duplicate in your workspace. You can return it to review later."
                            confirmLabel="Mark duplicate"
                            destructive
                            onConfirm={() => void handleSheetReviewAction(openDoc, "duplicate")}
                          />
                          <ConfirmDialog
                            trigger={
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={submittingAction !== null}
                              >
                                <Ban className="size-3.5" /> Reject
                              </Button>
                            }
                            title="Reject this document?"
                            description="This records a business rejection on the uploaded PDF without deleting the stored file."
                            confirmLabel="Reject document"
                            destructive
                            onConfirm={() => void handleSheetReviewAction(openDoc, "rejected")}
                          />
                        </div>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={submittingAction !== null}
                        onClick={() => void handleSheetReviewAction(openDoc, "needs_review")}
                      >
                        <RotateCcw className="size-3.5" />{" "}
                        {submittingAction === "needs_review" ? "Saving…" : "Return to review"}
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="text-[12.5px] text-muted-foreground">
                    This document is not uploaded yet and cannot enter business review.
                  </p>
                )}

                <Button variant="ink" className="w-full" asChild>
                  <Link
                    to="/app/batches/$id"
                    params={{ id: openDoc.batchId }}
                    search={{ doc: openDoc.id, invoice: undefined }}
                  >
                    Open PDF review workbench
                  </Link>
                </Button>

                <details className="border-t border-border pt-3 text-[12px] text-muted-foreground">
                  <summary className="cursor-pointer font-medium text-foreground">
                    Review history {loadingDetail ? "(loading…)" : `(${openEvents.length})`}
                  </summary>
                  {openEvents.length > 0 && (
                    <ul className="num mt-2 space-y-1.5">
                      {openEvents.map((ev) => (
                        <li
                          key={ev.id}
                          className="rounded-sm border border-border bg-surface px-2.5 py-1.5 text-[11px]"
                        >
                          <span className="text-foreground">
                            {formatReviewStatusLabel(ev.fromReviewStatus)} →{" "}
                            {formatReviewStatusLabel(ev.toReviewStatus)}
                          </span>{" "}
                          · {formatDate(ev.createdAt)}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
