import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, FileStack, Files, ListChecks, Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/gathr/common";
import { IngestionBatchStatusPill } from "@/components/gathr/status";
import { Button } from "@/components/ui/button";
import { formatDashboardDate, formatDate } from "@/lib/gathr/format";
import type {
  BatchListResponse,
  DocumentListResponse,
  PersistedBatchSummary,
  WorkspaceDocumentListItem,
  WorkspaceDocumentReviewCounts,
} from "@/lib/gathr/ingestion-types";
import { setPendingReviewBadgeCount } from "@/lib/gathr/review-client";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Overview | gathr" },
      { name: "description", content: "Where your documents stand." },
      { property: "og:title", content: "Overview — gathr" },
      { property: "og:description", content: "Where your documents stand." },
    ],
  }),
  component: Overview,
});

/**
 * Hydration-safe hook that returns the current formatted day/date in the browser's local timezone.
 * Refreshes on mount, across midnight transitions, on tab visibility changes, and via periodic interval.
 */
function useDashboardDate() {
  const [currentDate, setCurrentDate] = useState<string | undefined>(undefined);

  useEffect(() => {
    function updateDate() {
      const formatted = formatDashboardDate();
      setCurrentDate((prev) => (prev !== formatted ? formatted : prev));
    }

    updateDate();

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        updateDate();
      }
    }

    function handleFocus() {
      updateDate();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    let midnightTimer: ReturnType<typeof setTimeout>;

    function scheduleMidnightUpdate() {
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        0,
        500,
      );
      const msUntilMidnight = Math.max(1000, nextMidnight.getTime() - now.getTime());

      midnightTimer = setTimeout(() => {
        updateDate();
        scheduleMidnightUpdate();
      }, msUntilMidnight);
    }

    scheduleMidnightUpdate();
    const intervalId = setInterval(updateDate, 60_000);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      clearTimeout(midnightTimer);
      clearInterval(intervalId);
    };
  }, []);

  return currentDate;
}

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

export function Overview() {
  const { session } = Route.useRouteContext();
  const firstName = session?.user?.name?.trim().split(/\s+/)[0] || "there";
  const currentDate = useDashboardDate();

  const [batches, setBatches] = useState<PersistedBatchSummary[]>([]);
  const [documents, setDocuments] = useState<WorkspaceDocumentListItem[]>([]);
  const [counts, setCounts] = useState<WorkspaceDocumentReviewCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSummary() {
      if (typeof window !== "undefined" && !window.location?.origin?.startsWith("http")) {
        setLoading(false);
        return;
      }
      try {
        const [batchesRes, docsRes] = await Promise.all([
          fetch("/api/batches?limit=6", { credentials: "same-origin", signal: controller.signal }),
          fetch("/api/documents?limit=20", {
            credentials: "same-origin",
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted) return;

        if (batchesRes.ok) {
          const bData = (await batchesRes.json()) as BatchListResponse;
          if (!controller.signal.aborted && Array.isArray(bData.batches)) {
            setBatches(bData.batches);
          }
        }
        if (docsRes.ok) {
          const dData = (await docsRes.json()) as DocumentListResponse;
          if (!controller.signal.aborted) {
            setDocuments(Array.isArray(dData.documents) ? dData.documents : []);
            const nextCounts = dData.counts ?? EMPTY_COUNTS;
            setCounts(nextCounts);
            setPendingReviewBadgeCount(nextCounts.unreviewed + nextCounts.needsReview);
          }
        }
      } catch {
        // Preserve empty workspace summary when offline or unauthenticated
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadSummary();
    return () => controller.abort();
  }, []);

  const awaitingReview = counts.unreviewed + counts.needsReview;
  const flaggedOrExcluded = counts.duplicate + counts.rejected + counts.skipped;
  const firstAwaitingDoc = documents.find(
    (d) =>
      d.status === "uploaded" && (d.reviewStatus === null || d.reviewStatus === "needs_review"),
  );

  const stats = [
    [
      "Uploaded documents",
      counts.uploaded,
      `${counts.total} total document${counts.total === 1 ? "" : "s"} in workspace`,
    ],
    [
      "Awaiting review",
      awaitingReview,
      awaitingReview ? "uploaded PDFs pending decision" : "nothing waiting",
    ],
    [
      "Verified documents",
      counts.verified,
      `${counts.uploaded ? Math.round((counts.verified / counts.uploaded) * 100) : 0}% of uploaded PDFs`,
    ],
    ["Duplicate, rejected & skipped", flaggedOrExcluded, "flagged or excluded in review"],
  ] as const;

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 md:px-10 md:py-12">
      <PageHeader
        {...(currentDate ? { eyebrow: currentDate } : {})}
        title={
          <>
            Good morning, <em>{firstName}.</em>
          </>
        }
        actions={
          <Button variant="ink" asChild>
            <Link to="/app/new">
              <Plus /> New batch
            </Link>
          </Button>
        }
      >
        Here&apos;s where your persisted workspace documents stand.
      </PageHeader>

      <div className="grid grid-cols-2 border-b border-border lg:grid-cols-4">
        {stats.map(([l, v, s], i) => (
          <div
            key={l}
            className={`py-6 ${i % 2 ? "border-l border-border pl-5" : ""} ${i === 2 ? "lg:border-l lg:pl-5" : ""} ${i > 1 ? "border-t border-border lg:border-t-0" : ""}`}
          >
            <p className="text-[12.5px] text-muted-foreground">{l}</p>
            <p className="mt-3 font-serif text-[52px] leading-none">{v}</p>
            <p className="mt-2 text-[12px] text-muted-foreground">{s}</p>
          </div>
        ))}
      </div>

      <div className="mt-12 grid gap-12 xl:grid-cols-[1fr_280px]">
        <section>
          <div className="mb-4 flex items-end justify-between">
            <h2 className="font-serif text-[28px]">Recent activity</h2>
            <Link
              to="/app/batches"
              className="text-[13px] text-muted-foreground hover:text-foreground"
            >
              All batches →
            </Link>
          </div>

          {loading ? (
            <p
              role="status"
              aria-live="polite"
              className="py-6 text-[13.5px] text-muted-foreground"
            >
              Loading recent workspace batches…
            </p>
          ) : batches.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-6 py-10 text-center">
              <p className="font-serif text-xl">No batches yet</p>
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                Upload individual invoice PDFs to create your first persisted batch.
              </p>
              <Button variant="outline" size="sm" className="mt-4" asChild>
                <Link to="/app/new">Create batch</Link>
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-[13.5px]">
                <thead>
                  <tr className="border-y border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-2.5 font-normal">Batch</th>
                    <th className="font-normal">Created</th>
                    <th className="text-right font-normal">Uploaded</th>
                    <th className="text-right font-normal">Verified</th>
                    <th className="text-right font-normal">Awaiting review</th>
                    <th className="pl-6 font-normal">Upload status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const pendingOnly = b.documentCount > 0 && b.pendingCount === b.documentCount;
                    const batchAwaiting = (b.unreviewedCount ?? 0) + (b.needsReviewCount ?? 0);
                    return (
                      <tr
                        key={b.id}
                        className="group border-b border-border transition-colors hover:bg-surface"
                      >
                        <td className="py-3.5">
                          <Link
                            to="/app/batches/$id"
                            params={{ id: b.id }}
                            search={{ invoice: undefined, doc: undefined }}
                            className="hover:underline"
                          >
                            {b.name}
                          </Link>
                          <p className="num text-[11px] text-muted-foreground">{b.id}</p>
                        </td>
                        <td className="num text-[12px] text-muted-foreground">
                          {formatDate(b.createdAt)}
                        </td>
                        <td className="num text-right">
                          {b.uploadedCount}/{b.documentCount}
                        </td>
                        <td className="num text-right">{b.verifiedCount ?? 0}</td>
                        <td className="num text-right">{batchAwaiting}</td>
                        <td className="pl-6">
                          <IngestionBatchStatusPill status={b.status} pendingOnly={pendingOnly} />
                        </td>
                        <td className="text-right">
                          <Link
                            to="/app/batches/$id"
                            params={{ id: b.id }}
                            search={{ invoice: undefined, doc: undefined }}
                            className="inline-flex text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100"
                            aria-label={`Open ${b.name}`}
                          >
                            <ArrowUpRight className="size-4" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside>
          <h2 className="mb-4 font-serif text-[28px]">Quick actions</h2>
          <ul className="border-t border-border">
            <li className="border-b border-border">
              <Link
                to="/app/new"
                className="flex items-center gap-3 py-3.5 text-[13.5px] transition-colors hover:text-primary"
              >
                <FileStack className="size-4 text-muted-foreground" strokeWidth={1.6} /> Create
                document batch
              </Link>
            </li>
            <li className="border-b border-border">
              <Link
                to="/app/batches"
                className="flex items-center gap-3 py-3.5 text-[13.5px] transition-colors hover:text-primary"
              >
                <Files className="size-4 text-muted-foreground" strokeWidth={1.6} /> Browse all
                batches
              </Link>
            </li>
            <li className="border-b border-border">
              {firstAwaitingDoc ? (
                <Link
                  to="/app/batches/$id"
                  params={{ id: firstAwaitingDoc.batchId }}
                  search={{ doc: firstAwaitingDoc.id, invoice: undefined }}
                  className="flex items-center gap-3 py-3.5 text-[13.5px] transition-colors hover:text-primary"
                >
                  <ListChecks className="size-4 text-muted-foreground" strokeWidth={1.6} /> Review
                  awaiting ({awaitingReview})
                </Link>
              ) : (
                <Link
                  to="/app/invoices"
                  className="flex items-center gap-3 py-3.5 text-[13.5px] transition-colors hover:text-primary"
                >
                  <ListChecks className="size-4 text-muted-foreground" strokeWidth={1.6} /> Review
                  awaiting ({awaitingReview})
                </Link>
              )}
            </li>
            <li className="border-b border-border">
              <Link
                to="/app/invoices"
                className="flex items-center gap-3 py-3.5 text-[13.5px] transition-colors hover:text-primary"
              >
                <Search className="size-4 text-muted-foreground" strokeWidth={1.6} /> Browse
                workspace documents
              </Link>
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
