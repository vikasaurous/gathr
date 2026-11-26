import { useState, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, FileStack, Files, ListChecks, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/gathr/common";
import { BatchStatusPill, DemoBadge } from "@/components/gathr/status";
import { formatDate, formatDashboardDate } from "@/lib/gathr/format";
import { useWorkspace } from "@/lib/gathr/store";

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

    // 1. Initialize dynamic date after client mount (avoids SSR hydration mismatch)
    updateDate();

    // 2. Refresh when browser tab becomes visible again or window gains focus
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

    // 3. Keep date updated when date changes across midnight
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

    // 4. Periodic 60-second fallback to guard against clock skew or OS sleep
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

function Overview() {
  const ws = useWorkspace();
  const { session } = Route.useRouteContext();
  const firstName = session?.user?.name?.trim().split(/\s+/)[0] || "there";
  const currentDate = useDashboardDate();
  const inv = ws.invoices;
  const pending = inv.filter((i) => i.status === "needs_review");
  const verified = inv.filter((i) => i.status === "verified").length;
  const dups = inv.filter((i) => i.status === "duplicate").length;
  const stats = [
    [
      "Invoices processed",
      inv.length,
      `across ${ws.batches.filter((b) => b.status !== "failed").length} batches`,
    ],
    [
      "Pending review",
      pending.length,
      pending.length ? "fields need a second look" : "nothing waiting",
    ],
    [
      "Verified records",
      verified,
      `${inv.length ? Math.round((verified / inv.length) * 100) : 0}% of all invoices`,
    ],
    ["Marked duplicates", dups, "excluded from exports by default"],
  ] as const;
  const firstPending = pending[0];

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 md:px-10 md:py-12">
      <PageHeader
        eyebrow={currentDate}
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
        Here's where your documents stand. <DemoBadge className="ml-2 align-middle" />
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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[13.5px]">
              <thead>
                <tr className="border-y border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2.5 font-normal">Batch</th>
                  <th className="font-normal">Uploaded</th>
                  <th className="text-right font-normal">Detected</th>
                  <th className="text-right font-normal">Verified</th>
                  <th className="text-right font-normal">Review</th>
                  <th className="pl-6 font-normal">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ws.batches.slice(0, 6).map((b) => {
                  const own = inv.filter((i) => i.batchId === b.id);
                  return (
                    <tr
                      key={b.id}
                      className="group border-b border-border transition-colors hover:bg-surface"
                    >
                      <td className="py-3.5">
                        <Link
                          to="/app/batches/$id"
                          params={{ id: b.id }}
                          className="hover:underline"
                        >
                          {b.name}
                        </Link>
                        <p className="num text-[11px] text-muted-foreground">{b.id}</p>
                      </td>
                      <td className="num text-[12px] text-muted-foreground">
                        {formatDate(b.createdAt)}
                      </td>
                      <td className="num text-right">{own.length}</td>
                      <td className="num text-right">
                        {own.filter((i) => i.status === "verified").length}
                      </td>
                      <td className="num text-right">
                        {own.filter((i) => i.status === "needs_review").length}
                      </td>
                      <td className="pl-6">
                        <BatchStatusPill status={b.status} />
                      </td>
                      <td className="text-right">
                        <Link
                          to="/app/batches/$id"
                          params={{ id: b.id }}
                          className="inline-flex text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100"
                          aria-label="Open"
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
        </section>
        <aside>
          <h2 className="mb-4 font-serif text-[28px]">Quick actions</h2>
          <ul className="border-t border-border">
            {(
              [
                [FileStack, "Create document batch", "/app/new"],
                [Files, "Browse all batches", "/app/batches"],
                [
                  ListChecks,
                  `Review pending (${pending.length})`,
                  firstPending ? "review" : "/app/invoices",
                ],
                [Search, "Browse processed invoices", "/app/invoices"],
              ] as const
            ).map(([Icon, l, to]) => (
              <li key={l} className="border-b border-border">
                {to === "review" && firstPending ? (
                  <Link
                    to="/app/batches/$id"
                    params={{ id: firstPending.batchId }}
                    search={{ invoice: firstPending.id }}
                    className="flex items-center gap-3 py-3.5 text-[13.5px] transition-colors hover:text-primary"
                  >
                    <Icon className="size-4 text-muted-foreground" strokeWidth={1.6} /> {l}
                  </Link>
                ) : (
                  <Link
                    to={to === "review" ? "/app/invoices" : to}
                    className="flex items-center gap-3 py-3.5 text-[13.5px] transition-colors hover:text-primary"
                  >
                    <Icon className="size-4 text-muted-foreground" strokeWidth={1.6} /> {l}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
