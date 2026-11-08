import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog, PageHeader } from "@/components/gathr/common";
import { buildFileName } from "@/lib/gathr/export";
import { actions, useWorkspace } from "@/lib/gathr/store";
import type { ProcessingPreferences } from "@/lib/gathr/types";

export const Route = createFileRoute("/app/settings")({
  head: () => ({
    meta: [
      { title: "Settings — gathr" },
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

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 border-b border-border py-6 md:grid-cols-[280px_1fr]">
      <div><p className="text-[14px]">{title}</p>{hint && <p className="mt-1 text-[12.5px] text-muted-foreground">{hint}</p>}</div>
      <div>{children}</div>
    </div>
  );
}

function Settings() {
  const ws = useWorkspace();
  const sample = ws.invoices[0];
  return (
    <div className="mx-auto max-w-[960px] px-5 py-8 md:px-10 md:py-12">
      <PageHeader eyebrow="Workspace" title="Settings">Changes apply immediately and last for this session.</PageHeader>
      <Row title="Workspace name">
        <Input value={ws.workspaceName} onChange={(e) => actions.setWorkspaceName(e.target.value)} className="max-w-sm bg-surface" />
      </Row>
      <Row title="Processing defaults" hint="Used for every new batch.">
        <ul className="max-w-sm divide-y divide-border">
          {TOGGLES.map(([k, l]) => (
            <li key={k} className="flex items-center justify-between py-2.5 text-[13.5px]">
              <label htmlFor={`s-${k}`}>{l}</label>
              <Switch id={`s-${k}`} checked={ws.prefs[k]} onCheckedChange={(v) => actions.setPrefs({ [k]: v })} />
            </li>
          ))}
        </ul>
      </Row>
      <Row title="Default export format">
        <div className="flex flex-wrap gap-2">
          {(["csv", "xlsx", "pdf", "zip"] as const).map((f) => (
            <Button key={f} size="sm" variant={ws.prefs.exportFormat === f ? "ink" : "outline"} onClick={() => actions.setPrefs({ exportFormat: f })}>{f.toUpperCase()}</Button>
          ))}
        </div>
      </Row>
      <Row title="Filename template" hint="Tokens: {vendor} {invoice_number} {date} {gstin}">
        <Input value={ws.filenameTemplate} onChange={(e) => actions.setTemplate(e.target.value)} className="num max-w-md bg-surface text-[12.5px]" />
        {sample && <p className="num mt-2 text-[12px] text-primary">→ {buildFileName(ws.filenameTemplate, sample)}</p>}
      </Row>
      <Row title="Demo data" hint="Restore the original sample batches and discard your changes.">
        <ConfirmDialog
          trigger={<Button variant="outline">Reset workspace</Button>}
          title="Reset the workspace?"
          description="All batches, corrections and settings return to the demonstration defaults."
          confirmLabel="Reset"
          destructive
          onConfirm={() => { actions.reset(); toast.success("Workspace reset"); }}
        />
      </Row>
    </div>
  );
}
