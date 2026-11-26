import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog, PageHeader } from "@/components/gathr/common";
import { buildFileName } from "@/lib/gathr/export";
import { actions, useWorkspace } from "@/lib/gathr/store";
import type { ProcessingPreferences } from "@/lib/gathr/types";
import { authClient } from "@/lib/auth/client";
import { getAuthErrorMessage } from "@/lib/auth/errors";
import { PlanCard } from "@/components/gathr/plan-card";

export const Route = createFileRoute("/app/settings")({
  validateSearch: (search: Record<string, unknown>) => ({
    linked:
      typeof search.linked === "string" && search.linked.trim() ? search.linked.trim() : undefined,
    error:
      typeof search.error === "string" && search.error.trim() ? search.error.trim() : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Settings | gathr" },
      { name: "description", content: "Workspace, processing and export preferences." },
      { property: "og:title", content: "Settings — gathr" },
      { property: "og:description", content: "Workspace, processing and export preferences." },
    ],
  }),
  component: Settings,
});

const TOGGLES: [keyof Omit<ProcessingPreferences, "exportFormat">, string][] = [
  ["detectInvoices", "Automatic invoice detection"],
  ["detectDuplicates", "Duplicate detection"],
  ["extractGst", "GST detail extraction"],
  ["extractVendor", "Vendor extraction"],
  ["autoName", "Automatic file naming"],
];

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-3 border-b border-border py-6 md:grid-cols-[280px_1fr]">
      <div>
        <p className="text-[14px]">{title}</p>
        {hint && <p className="mt-1 text-[12.5px] text-muted-foreground">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function Settings() {
  const ws = useWorkspace();
  const search = Route.useSearch();
  const { plan } = Route.useRouteContext();
  const sample = ws.invoices[0];

  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [linkingGoogle, setLinkingGoogle] = useState(false);

  // Load linked accounts on mount
  useEffect(() => {
    let mounted = true;
    async function loadAccounts() {
      try {
        const res = await authClient.listAccounts();
        if (mounted && res.data && Array.isArray(res.data)) {
          setConnectedProviders(res.data.map((a: { providerId: string }) => a.providerId));
        }
      } catch (err) {
        console.error("Failed to fetch linked accounts:", err);
      } finally {
        if (mounted) setLoadingAccounts(false);
      }
    }
    loadAccounts();
    return () => {
      mounted = false;
    };
  }, []);

  // Handle post-linking feedback notifications from OAuth callback redirects
  useEffect(() => {
    if (search.linked === "google") {
      toast.success("Google account linked successfully.");
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", "/app/settings");
      }
    } else if (search.error) {
      const mapped = getAuthErrorMessage(search.error);
      toast.error(mapped?.message || "Could not link Google account.");
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", "/app/settings");
      }
    }
  }, [search.linked, search.error]);

  async function handleConnectGoogle() {
    if (linkingGoogle) return;
    setLinkingGoogle(true);
    try {
      await authClient.linkSocial({
        provider: "google",
        callbackURL: "/app/settings?linked=google",
        errorCallbackURL: "/app/settings",
      });
    } catch {
      setLinkingGoogle(false);
      toast.error("Failed to initiate Google account linking. Please try again.");
    }
  }

  const hasCredentialAccount = connectedProviders.includes("credential");
  const isGoogleConnected = connectedProviders.includes("google");

  return (
    <div className="mx-auto max-w-[960px] px-5 py-8 md:px-10 md:py-12">
      <PageHeader eyebrow="Workspace" title="Settings">
        Changes apply immediately and last for this session.
      </PageHeader>

      <Row title="Plan" hint="Your current gathr plan and what it includes.">
        <PlanCard plan={plan} />
      </Row>

      <Row title="Workspace name">
        <Input
          value={ws.workspaceName}
          onChange={(e) => actions.setWorkspaceName(e.target.value)}
          className="max-w-sm bg-surface"
        />
      </Row>

      {/* Connected Accounts Section */}
      <Row
        title="Connected accounts"
        hint="Social login providers and credentials linked to your identity."
      >
        <div className="max-w-md space-y-3">
          {/* Email / Password Provider */}
          <div className="flex items-center justify-between rounded-md border border-border bg-surface px-3.5 py-3 text-[13.5px]">
            <div>
              <p className="font-medium text-foreground">Email & password</p>
              <p className="text-[12px] text-muted-foreground">
                {loadingAccounts || hasCredentialAccount
                  ? "Workspace credentials"
                  : "Signed in with a linked provider"}
              </p>
            </div>
            {loadingAccounts ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : hasCredentialAccount ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-[#425B51]/30 bg-[#425B51]/10 px-2 py-0.5 text-[11px] font-medium text-[#425B51]">
                <Check className="size-3" />
                Active
              </span>
            ) : (
              <span className="inline-flex items-center rounded-sm border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Not set
              </span>
            )}
          </div>

          {/* Google Provider */}
          <div className="flex items-center justify-between rounded-md border border-border bg-surface px-3.5 py-3 text-[13.5px]">
            <div className="flex items-center gap-2.5">
              <GoogleIcon />
              <div>
                <p className="font-medium text-foreground">Google</p>
                <p className="text-[12px] text-muted-foreground">
                  {isGoogleConnected
                    ? "Connected for sign-in"
                    : "Connect for 1-click Google sign-in"}
                </p>
              </div>
            </div>

            {loadingAccounts ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : isGoogleConnected ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-[#425B51]/30 bg-[#425B51]/10 px-2 py-0.5 text-[11px] font-medium text-[#425B51]">
                <Check className="size-3" />
                Connected
              </span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnectGoogle}
                disabled={linkingGoogle}
                className="text-[12px]"
              >
                {linkingGoogle ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  "Connect Google"
                )}
              </Button>
            )}
          </div>
        </div>
      </Row>

      <Row title="Processing defaults" hint="Used for every new batch.">
        <ul className="max-w-sm divide-y divide-border">
          {TOGGLES.map(([k, l]) => (
            <li key={k} className="flex items-center justify-between py-2.5 text-[13.5px]">
              <label htmlFor={`s-${k}`}>{l}</label>
              <Switch
                id={`s-${k}`}
                checked={ws.prefs[k]}
                onCheckedChange={(v) => actions.setPrefs({ [k]: v })}
              />
            </li>
          ))}
        </ul>
      </Row>

      <Row title="Default export format">
        <div className="flex flex-wrap gap-2">
          {(["csv", "xlsx", "pdf", "zip"] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={ws.prefs.exportFormat === f ? "ink" : "outline"}
              onClick={() => actions.setPrefs({ exportFormat: f })}
            >
              {f.toUpperCase()}
            </Button>
          ))}
        </div>
      </Row>

      <Row title="Filename template" hint="Tokens: {vendor} {invoice_number} {date} {gstin}">
        <Input
          value={ws.filenameTemplate}
          onChange={(e) => actions.setTemplate(e.target.value)}
          className="num max-w-md bg-surface text-[12.5px]"
        />
        {sample && (
          <p className="num mt-2 text-[12px] text-primary">
            → {buildFileName(ws.filenameTemplate, sample)}
          </p>
        )}
      </Row>

      <Row title="Demo data" hint="Restore the original sample batches and discard your changes.">
        <ConfirmDialog
          trigger={<Button variant="outline">Reset workspace</Button>}
          title="Reset the workspace?"
          description="All batches, corrections and settings return to the demonstration defaults."
          confirmLabel="Reset"
          destructive
          onConfirm={() => {
            actions.reset();
            toast.success("Workspace reset");
          }}
        />
      </Row>
    </div>
  );
}
