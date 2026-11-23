import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { ArrowLeft, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useState } from "react";
import { Wordmark } from "@/components/gathr/brand";
import { PageHeader } from "@/components/gathr/common";
import { Pill } from "@/components/gathr/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getAdminAccessFn,
  getAdminOverviewFn,
  listAdminUsersFn,
  setUserPlanFn,
} from "@/lib/admin/functions";
import { getSessionFn } from "@/lib/auth/functions";
import { formatDate } from "@/lib/gathr/format";
import { PLAN_IDS, PLAN_LABELS, isPlanId, type PlanId } from "@/lib/gathr/plans";

function parsePage(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : 1;
}

export const Route = createFileRoute("/admin")({
  validateSearch: (search: Record<string, unknown>) => ({
    page: parsePage(search["page"]),
    q: typeof search["q"] === "string" ? search["q"].trim().slice(0, 100) : "",
  }),
  beforeLoad: async () => {
    // UX guard only — every admin server function re-verifies access itself.
    const session = await getSessionFn();
    if (!session) {
      throw redirect({
        to: "/login",
        search: { verified: undefined, email: undefined, error: undefined },
      });
    }
    const { isAdmin } = await getAdminAccessFn();
    // Non-admins see the generic 404 so the admin area is not discoverable.
    if (!isAdmin) throw notFound();
  },
  loaderDeps: ({ search }) => ({ page: search.page, q: search.q }),
  loader: async ({ deps }) => {
    const [overview, users] = await Promise.all([
      getAdminOverviewFn(),
      listAdminUsersFn({ data: { page: deps.page, q: deps.q } }),
    ]);
    return { overview, users };
  },
  head: () => ({
    meta: [{ title: "Admin | gathr" }, { name: "robots", content: "noindex, nofollow, noarchive" }],
  }),
  component: AdminPage,
});

function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function providerLabel(id: string): string {
  if (id === "credential") return "Email";
  if (id === "google") return "Google";
  return id;
}

function AdminPage() {
  const { overview, users } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin" });
  const router = useRouter();
  const [draft, setDraft] = useState(search.q);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  async function changePlan(userId: string, plan: PlanId) {
    setSavingId(userId);
    setPlanError(null);
    try {
      await setUserPlanFn({ data: { userId, plan } });
      await router.invalidate();
    } catch (err) {
      console.error("[admin] plan update failed:", err);
      setPlanError("Couldn't update the plan. Please try again.");
    } finally {
      setSavingId(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(users.total / users.pageSize));
  const from = users.total === 0 ? 0 : (users.page - 1) * users.pageSize + 1;
  const to = Math.min(users.page * users.pageSize, users.total);

  const stats: [string, number, string][] = [
    ["Total users", overview.totalUsers, `${overview.verifiedUsers} verified`],
    ["New · 7 days", overview.newUsers7d, "Sign-ups"],
    ["New · 30 days", overview.newUsers30d, "Sign-ups"],
    ["Active sessions", overview.activeSessions, "Not yet expired"],
  ];

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    void navigate({ search: { page: 1, q: draft.trim() } });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-5 py-4 md:px-10">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between">
          <Wordmark to="/app" />
          <Button variant="outline" size="sm" asChild>
            <Link to="/app">
              <ArrowLeft /> Workspace
            </Link>
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-[1180px] px-5 py-8 md:px-10 md:py-12">
        <PageHeader
          eyebrow="Owner console"
          title={
            <>
              Admin <em>overview.</em>
            </>
          }
        >
          Read-only view of accounts. Visible only to the configured owner.
        </PageHeader>

        <div className="grid grid-cols-2 border-b border-border lg:grid-cols-4">
          {stats.map(([label, value, hint], i) => (
            <div
              key={label}
              className={`py-6 ${i % 2 ? "border-l border-border pl-5" : ""} ${i === 2 ? "lg:border-l lg:pl-5" : ""} ${i > 1 ? "border-t border-border lg:border-t-0" : ""}`}
            >
              <p className="text-[12.5px] text-muted-foreground">{label}</p>
              <p className="mt-3 font-serif text-[52px] leading-none">
                {value.toLocaleString("en-IN")}
              </p>
              <p className="mt-2 text-[12px] text-muted-foreground">{hint}</p>
            </div>
          ))}
        </div>

        <section className="mt-12">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="font-serif text-[28px] leading-none">Users</h2>
              <p className="mt-2 text-[12.5px] text-muted-foreground">
                {users.total === 0
                  ? "No matching users."
                  : `Showing ${from}–${to} of ${users.total.toLocaleString("en-IN")}`}
              </p>
              <p className="num mt-1 text-[12px] text-muted-foreground">
                Plans:{" "}
                {PLAN_IDS.map((id) => `${PLAN_LABELS[id]} ${overview.planCounts[id]}`).join(" · ")}
              </p>
            </div>
            <form onSubmit={submitSearch} className="flex w-full gap-2 md:w-auto" role="search">
              <div className="relative flex-1 md:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Search name or email"
                  maxLength={100}
                  aria-label="Search users"
                  className="bg-surface pl-9"
                />
              </div>
              <Button type="submit" variant="ink">
                Search
              </Button>
              {search.q && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDraft("");
                    void navigate({ search: { page: 1, q: "" } });
                  }}
                >
                  Clear
                </Button>
              )}
            </form>
          </div>

          {planError && (
            <p role="alert" className="mb-3 text-[12.5px] text-destructive">
              {planError}
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-[13.5px]">
              <thead>
                <tr className="border-y border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2.5 font-normal">User</th>
                  <th className="font-normal">Status</th>
                  <th className="font-normal">Plan</th>
                  <th className="font-normal">Sign-in methods</th>
                  <th className="font-normal">Joined</th>
                  <th className="font-normal">Last sign-in</th>
                  <th className="text-right font-normal">Sessions</th>
                </tr>
              </thead>
              <tbody>
                {users.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-muted-foreground">
                      {users.page > 1 ? (
                        <>
                          This page is empty.{" "}
                          <Link
                            to="/admin"
                            search={{ page: 1, q: users.query }}
                            className="underline"
                          >
                            Back to first page
                          </Link>
                        </>
                      ) : (
                        "No users found."
                      )}
                    </td>
                  </tr>
                ) : (
                  users.rows.map((u) => (
                    <tr
                      key={u.id}
                      className="border-b border-border transition-colors hover:bg-surface"
                    >
                      <td className="py-3.5 pr-4">
                        <p className="max-w-[260px] truncate">{u.name || "—"}</p>
                        <p className="num max-w-[260px] truncate text-[11px] text-muted-foreground">
                          {u.email}
                        </p>
                      </td>
                      <td>
                        <Pill tone={u.emailVerified ? "success" : "warning"}>
                          {u.emailVerified ? "Verified" : "Unverified"}
                        </Pill>
                      </td>
                      <td>
                        <select
                          value={u.plan}
                          disabled={savingId === u.id}
                          aria-label={`Plan for ${u.email}`}
                          onChange={(e) => {
                            const next = e.target.value;
                            if (isPlanId(next) && next !== u.plan) void changePlan(u.id, next);
                          }}
                          className="h-8 rounded-md border border-border bg-surface px-2 text-[12.5px] disabled:opacity-50"
                        >
                          {PLAN_IDS.map((id) => (
                            <option key={id} value={id}>
                              {PLAN_LABELS[id]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="text-[12.5px] text-muted-foreground">
                        {u.providers.length ? u.providers.map(providerLabel).join(", ") : "—"}
                      </td>
                      <td className="num text-[12px] text-muted-foreground">
                        {formatDate(u.createdAt)}
                      </td>
                      <td className="num text-[12px] text-muted-foreground">
                        {formatDateTime(u.lastSignInAt)}
                      </td>
                      <td className="num text-right">{u.activeSessions}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <nav className="mt-5 flex items-center justify-between" aria-label="Pagination">
              <Button
                variant="outline"
                size="sm"
                disabled={users.page <= 1}
                asChild={users.page > 1}
              >
                {users.page > 1 ? (
                  <Link to="/admin" search={{ page: users.page - 1, q: users.query }}>
                    <ChevronLeft /> Previous
                  </Link>
                ) : (
                  <span>
                    <ChevronLeft /> Previous
                  </span>
                )}
              </Button>
              <span className="num text-[12px] text-muted-foreground">
                Page {users.page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={users.page >= totalPages}
                asChild={users.page < totalPages}
              >
                {users.page < totalPages ? (
                  <Link to="/admin" search={{ page: users.page + 1, q: users.query }}>
                    Next <ChevronRight />
                  </Link>
                ) : (
                  <span>
                    Next <ChevronRight />
                  </span>
                )}
              </Button>
            </nav>
          )}
        </section>
      </div>
    </div>
  );
}
