import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import {
  ChevronsUpDown,
  FilePlus2,
  FileText,
  HelpCircle,
  Layers,
  LayoutGrid,
  LogOut,
  Settings,
} from "lucide-react";
import { Wordmark } from "@/components/gathr/brand";
import { actions, useWorkspace } from "@/lib/gathr/store";
import { cn } from "@/lib/utils";
import { getSessionFn } from "@/lib/auth/functions";
import { getMyPlanFn } from "@/lib/plan/functions";
import { SidebarPlanLink } from "@/components/gathr/plan-badge";
import { SignOutDialog } from "@/components/gathr/sign-out-dialog";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    // Server-side session check using TanStack Start server function.
    // Executes on server in SSR and via RPC from browser with session cookies.
    const session = await getSessionFn();
    if (!session) {
      throw redirect({ to: "/login" });
    }
    // Never show another account's in-memory workspace data (client only; the server
    // renders from a fixed snapshot).
    if (typeof window !== "undefined") actions.bindUser(session.user.id);
    // Fresh on every navigation, so a plan changed by the owner shows up right away.
    const { plan } = await getMyPlanFn();
    return { session, plan };
  },
  head: () => ({
    meta: [
      { title: "Workspace — gathr" },
      { name: "description", content: "Your gathr invoice processing workspace." },
      { property: "og:title", content: "Workspace — gathr" },
      { property: "og:description", content: "Your gathr invoice processing workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AppLayout,
});

const NAV = [
  { to: "/app", label: "Overview", icon: LayoutGrid, exact: true },
  { to: "/app/new", label: "New batch", icon: FilePlus2 },
  { to: "/app/batches", label: "All batches", icon: Layers },
  { to: "/app/invoices", label: "Invoices", icon: FileText },
  { to: "/app/settings", label: "Settings", icon: Settings },
] as const;

function AppLayout() {
  const ws = useWorkspace();
  const { session, plan } = Route.useRouteContext();
  const user = session?.user;
  const displayName = user?.name?.trim() || user?.email || "Account";
  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "A";
  const pending = ws.invoices.filter((i) => i.status === "needs_review").length;
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-border bg-secondary lg:flex">
        <div className="px-5 pb-6 pt-5">
          <Wordmark to="/app" />
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: "exact" in n }}
              className="group flex items-center gap-3 rounded-md px-2.5 py-2 text-[13.5px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              activeProps={{
                className:
                  "bg-background text-foreground shadow-[inset_2px_0_0_var(--color-primary)]",
              }}
            >
              <n.icon className="size-4" strokeWidth={1.6} />
              <span className="flex-1">{n.label}</span>
              {n.to === "/app/invoices" && pending > 0 && (
                <span className="num text-[11px] text-warning">{pending}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="space-y-1 border-t border-border p-3">
          <a
            href="mailto:hello@gathr.example"
            className="flex items-center gap-3 rounded-md px-2.5 py-2 text-[13px] text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <HelpCircle className="size-4" strokeWidth={1.6} /> Help
          </a>
          <SidebarPlanLink plan={plan} />
          <div className="flex items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-2">
            <span className="grid size-7 place-items-center rounded-sm bg-primary font-serif text-[15px] text-primary-foreground">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px]">{ws.workspaceName}</p>
              <p className="truncate text-[11px] text-muted-foreground">{displayName}</p>
            </div>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </div>
          <SignOutDialog
            trigger={
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              >
                <LogOut className="size-4" strokeWidth={1.6} /> Sign out
              </button>
            }
          />
        </div>
      </aside>

      {/* Mobile top + bottom navigation */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm lg:hidden">
        <Wordmark to="/app" />
        <SignOutDialog
          trigger={
            <button
              type="button"
              className="grid size-8 place-items-center rounded-sm bg-primary font-serif text-primary-foreground transition-opacity hover:opacity-90"
              aria-label="Account options / Sign out"
            >
              {initials}
            </button>
          }
        />
      </header>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-background/95 backdrop-blur-sm lg:hidden">
        {NAV.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            activeOptions={{ exact: "exact" in n }}
            className="flex flex-col items-center gap-1 py-2.5 text-[10.5px] text-muted-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            <n.icon className="size-[18px]" strokeWidth={1.6} />
            {n.label.replace("All ", "")}
          </Link>
        ))}
      </nav>

      <main className={cn("min-w-0 pb-24 lg:pb-0")}>
        <Outlet />
      </main>
    </div>
  );
}
