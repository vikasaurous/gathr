import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpDown, MoreHorizontal, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { EmptyState, FilterTabs, PageHeader } from "@/components/gathr/common";
import { BatchStatusPill } from "@/components/gathr/status";
import { downloadText, invoicesToCsv } from "@/lib/gathr/export";
import { formatBytes, formatDate } from "@/lib/gathr/format";
import { actions, useWorkspace } from "@/lib/gathr/store";
import type { BatchStatus } from "@/lib/gathr/types";

export const Route = createFileRoute("/app/batches/")({
  head: () => ({
    meta: [
      { title: "Batches | gathr" },
      { name: "description", content: "Every document batch you have processed." },
      { property: "og:title", content: "Batches — gathr" },
      { property: "og:description", content: "Every document batch you have processed." },
    ],
  }),
  component: Batches,
});

type F = "all" | BatchStatus;
type SortOrder = "newest" | "oldest";

function Batches() {
  const ws = useWorkspace();
  const [filter, setFilter] = useState<F>("all");
  const [q, setQ] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      [...ws.batches]
        .filter(
          (b) =>
            (filter === "all" || b.status === filter) &&
            (b.name + b.id + b.files.map((f) => f.name).join())
              .toLowerCase()
              .includes(q.toLowerCase()),
        )
        .sort((a, b) =>
          sortOrder === "newest"
            ? b.createdAt.localeCompare(a.createdAt)
            : a.createdAt.localeCompare(b.createdAt),
        ),
    [ws.batches, filter, q, sortOrder],
  );
  const count = (s: F) =>
    s === "all" ? ws.batches.length : ws.batches.filter((b) => b.status === s).length;
  const opts = (["all", "processing", "completed", "needs_review", "failed"] as F[]).map((v) => ({
    value: v,
    label: {
      all: "All",
      processing: "Processing",
      completed: "Completed",
      needs_review: "Needs review",
      failed: "Failed",
    }[v],
    count: count(v),
  }));
  const toDelete = ws.batches.find((b) => b.id === confirmId);

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
        Every upload, with its source files and processing state.
      </PageHeader>
      <div className="flex flex-col gap-3 py-5 md:flex-row md:items-center md:justify-between">
        <FilterTabs value={filter} onChange={setFilter} options={opts} />
        <div className="flex gap-2">
          <div className="relative flex-1 md:w-64">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search batches or files"
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
      {rows.length === 0 ? (
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
            : "Upload a PDF to create your first batch."}
        </EmptyState>
      ) : (
        <ul className="border-t border-foreground">
          {rows.map((b) => {
            const own = ws.invoices.filter((i) => i.batchId === b.id);
            const pages = b.files.reduce((s, f) => s + f.pageCount, 0);
            return (
              <li
                key={b.id}
                className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border py-5 md:grid-cols-[110px_1fr_140px_120px_130px_40px]"
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
                    {b.id} · {b.files.length} file{b.files.length > 1 ? "s" : ""} ·{" "}
                    {formatBytes(b.files.reduce((s, f) => s + f.size, 0))}
                    {pages ? ` · ${pages} pages` : ""}
                  </p>
                  {b.error && <p className="mt-1 text-[12px] text-destructive">{b.error}</p>}
                </div>
                <span className="num hidden text-[13px] md:block">
                  {own.length} invoices
                  <br />
                  <span className="text-muted-foreground">
                    {own.filter((i) => i.status === "verified").length} verified
                  </span>
                </span>
                <span className="hidden md:block">
                  <BatchStatusPill status={b.status} />
                </span>
                <span className="hidden md:block">
                  {b.status !== "failed" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-[36px] w-[76px] min-w-[76px] max-w-[76px] shrink-0 inline-flex items-center justify-center text-center"
                      asChild
                    >
                      <Link
                        to="/app/batches/$id"
                        params={{ id: b.id }}
                        className="h-[36px] w-[76px] min-w-[76px] max-w-[76px] shrink-0 inline-flex items-center justify-center text-center"
                      >
                        {b.status === "needs_review" ? "Review" : "Open"}
                      </Link>
                    </Button>
                  )}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Batch actions">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {b.status !== "failed" && (
                      <DropdownMenuItem asChild>
                        <Link to="/app/batches/$id" params={{ id: b.id }}>
                          Open review
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      disabled={!own.length}
                      onClick={() => {
                        downloadText(`${b.id}.csv`, invoicesToCsv(own));
                        toast.success("CSV downloaded");
                      }}
                    >
                      Download CSV
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setConfirmId(b.id)}
                    >
                      Delete batch
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="col-span-2 flex items-center gap-3 md:hidden">
                  <BatchStatusPill status={b.status} />
                  <span className="num text-[11px] text-muted-foreground">
                    {own.length} invoices · {formatDate(b.createdAt)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {toDelete && (
        <DeleteConfirm
          name={toDelete.name}
          onCancel={() => setConfirmId(null)}
          onConfirm={() => {
            actions.deleteBatch(toDelete.id);
            setConfirmId(null);
            toast.success("Batch deleted");
          }}
        />
      )}
    </div>
  );
}

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

function DeleteConfirm({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif text-2xl font-normal">
            Delete “{name}”?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The batch and all its invoices, including your corrections, will be removed from this
            workspace.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            Delete batch
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
