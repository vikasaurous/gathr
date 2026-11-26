import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpDown, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, FilterTabs, PageHeader } from "@/components/gathr/common";
import { IngestionBatchStatusPill, Pill } from "@/components/gathr/status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { formatBytes, formatDate } from "@/lib/gathr/format";
import type {
  BatchIngestionStatus,
  BatchListResponse,
  PersistedBatchSummary,
} from "@/lib/gathr/ingestion-types";

export const Route = createFileRoute("/app/batches/")({
  head: () => ({
    meta: [
      { title: "Batches | gathr" },
      { name: "description", content: "Every document batch in your workspace." },
      { property: "og:title", content: "Batches — gathr" },
      { property: "og:description", content: "Every document batch in your workspace." },
    ],
  }),
  component: Batches,
});

type F = "all" | BatchIngestionStatus;
type SortOrder = "newest" | "oldest";

function Batches() {
  const [batches, setBatches] = useState<PersistedBatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<F>("all");
  const [q, setQ] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");

  const loadBatches = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/batches", {
        method: "GET",
        credentials: "same-origin",
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) return;
      if (!res.ok) {
        let message = "Could not load workspace batches.";
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error) message = body.error;
        } catch {
          // Keep safe fallback message
        }
        setLoadError(message);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as BatchListResponse;
      setBatches(Array.isArray(data.batches) ? data.batches : []);
      setLoading(false);
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) return;
      // In non-HTTP test environments (e.g., jsdom routing unit tests without mocked fetch),
      // treat relative-URL fetch TypeError as empty initial list instead of crashing navigation.
      if (typeof window !== "undefined" && !window.location?.origin?.startsWith("http")) {
        setBatches([]);
        setLoading(false);
        return;
      }
      setLoadError("Network error while loading workspace batches.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadBatches(controller.signal);
    return () => controller.abort();
  }, [loadBatches]);

  const rows = useMemo(
    () =>
      [...batches]
        .filter(
          (b) =>
            (filter === "all" || b.status === filter) &&
            (b.name + b.id).toLowerCase().includes(q.toLowerCase()),
        )
        .sort((a, b) =>
          sortOrder === "newest"
            ? b.createdAt.localeCompare(a.createdAt)
            : a.createdAt.localeCompare(b.createdAt),
        ),
    [batches, filter, q, sortOrder],
  );

  const count = (s: F) =>
    s === "all" ? batches.length : batches.filter((b) => b.status === s).length;
  const opts = (["all", "uploading", "uploaded", "partial", "failed"] as F[]).map((v) => ({
    value: v,
    label: {
      all: "All",
      uploading: "In progress",
      uploaded: "Uploaded",
      partial: "Partial",
      failed: "Failed",
    }[v],
    count: count(v),
  }));

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 md:px-10 md:py-12">
      <PageHeader
        eyebrow="Archive"
        title="All batches"
        actions={
          <Button variant="ink" asChild>
            <Link to="/app/new">
              <Plus /> New batch
            </Link>
          </Button>
        }
      >
        Every upload, with its source files and upload status.
      </PageHeader>
      <div className="flex flex-col gap-3 py-5 md:flex-row md:items-center md:justify-between">
        <FilterTabs value={filter} onChange={setFilter} options={opts} />
        <div className="flex gap-2">
          <div className="relative flex-1 md:w-64">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search batches"
              className="bg-surface pl-9"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Sort by date">
                <ArrowUpDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuRadioGroup
                value={sortOrder}
                onValueChange={(v) => setSortOrder(v as SortOrder)}
              >
                <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {loading ? (
        <p className="py-12 text-[14px] text-muted-foreground">Loading batches…</p>
      ) : loadError ? (
        <EmptyState
          title="Could not load batches."
          action={
            <Button variant="outline" onClick={() => void loadBatches()}>
              <RefreshCw className="size-4" /> Retry
            </Button>
          }
        >
          {loadError}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          title={q || filter !== "all" ? "No batches match." : "No batches yet."}
          action={
            q || filter !== "all" ? (
              <Button
                variant="outline"
                onClick={() => {
                  setQ("");
                  setFilter("all");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button variant="ink" asChild>
                <Link to="/app/new">Start a batch</Link>
              </Button>
            )
          }
        >
          {q || filter !== "all"
            ? "Try a different search or filter."
            : "Select individual invoice PDFs to create your first batch."}
        </EmptyState>
      ) : (
        <ul className="border-t border-foreground">
          {rows.map((b) => {
            const pendingOnly = b.documentCount > 0 && b.pendingCount === b.documentCount;
            return (
              <li
                key={b.id}
                className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border py-5 md:grid-cols-[110px_1fr_140px_140px_100px]"
              >
                <span className="num hidden text-[12px] text-muted-foreground md:block">
                  {formatDate(b.createdAt)}
                </span>
                <div className="min-w-0">
                  <Link
                    to="/app/batches/$id"
                    params={{ id: b.id }}
                    className="font-serif text-[22px] leading-tight hover:underline"
                  >
                    {b.name}
                  </Link>
                  <p className="num mt-1 truncate text-[11px] text-muted-foreground">
                    {b.id} · {b.documentCount} document{b.documentCount === 1 ? "" : "s"} ·{" "}
                    {formatBytes(b.totalSizeBytes)}
                  </p>
                </div>
                <span className="num hidden text-[13px] md:block">
                  {b.uploadedCount} uploaded
                  <br />
                  <span className="text-muted-foreground">
                    {b.pendingCount} pending
                    {b.failedCount > 0 ? ` · ${b.failedCount} failed` : ""}
                  </span>
                </span>
                <span className="hidden md:flex md:flex-wrap md:items-center md:gap-1.5">
                  <IngestionBatchStatusPill status={b.status} pendingOnly={pendingOnly} />
                  {b.finalizedAt && <Pill tone="neutral">Finalized</Pill>}
                </span>
                <span className="hidden justify-end md:flex">
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/app/batches/$id" params={{ id: b.id }}>
                      Open
                    </Link>
                  </Button>
                </span>
                <span className="col-span-2 flex flex-wrap items-center gap-3 md:hidden">
                  <IngestionBatchStatusPill status={b.status} pendingOnly={pendingOnly} />
                  {b.finalizedAt && <Pill tone="neutral">Finalized</Pill>}
                  <span className="num text-[11px] text-muted-foreground">
                    {b.documentCount} documents · {formatDate(b.createdAt)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
