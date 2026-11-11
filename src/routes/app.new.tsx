import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { checkFile, FileDrop, MAX_FILES, type QueuedFile } from "@/components/gathr/file-drop";
import { ProcessingProgress } from "@/components/gathr/processing-progress";
import { demoEngine } from "@/lib/gathr/processing";
import { actions, nextBatchId, useWorkspace } from "@/lib/gathr/store";
import type { ProcessingPreferences } from "@/lib/gathr/types";

export const Route = createFileRoute("/app/new")({
  head: () => ({
    meta: [
      { title: "New batch — gathr" },
      {
        name: "description",
        content: "Upload combined PDFs or individual invoices to start a new batch.",
      },
      { property: "og:title", content: "New batch — gathr" },
      {
        property: "og:description",
        content: "Upload combined PDFs or individual invoices to start a new batch.",
      },
    ],
  }),
  component: NewBatch,
});

const PREFS: {
  key: keyof Omit<ProcessingPreferences, "exportFormat">;
  label: string;
  hint: string;
}[] = [
  {
    key: "detectInvoices",
    label: "Automatic invoice detection",
    hint: "Split combined PDFs at invoice boundaries.",
  },
  {
    key: "detectDuplicates",
    label: "Duplicate detection",
    hint: "Flag repeated invoice numbers per supplier.",
  },
  { key: "extractGst", label: "GST detail extraction", hint: "GSTIN, CGST, SGST and IGST." },
  { key: "extractVendor", label: "Vendor extraction", hint: "Supplier name and details." },
  { key: "autoName", label: "Automatic file naming", hint: "Rename using your filename template." },
];

function NewBatch() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [name, setName] = useState("");
  const [run, setRun] = useState<{ stage: number; progress: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = files.filter((f) => !f.error);

  function add(list: File[]) {
    setError(null);
    setFiles((cur) => {
      const room = MAX_FILES - cur.length;
      if (list.length > room) toast.error(`You can add up to ${MAX_FILES} files per batch.`);
      return [
        ...cur,
        ...list
          .slice(0, Math.max(0, room))
          .map((file) => ({ id: crypto.randomUUID(), file, error: checkFile(file) })),
      ];
    });
  }

  async function start() {
    if (!valid.length) return;
    const id = nextBatchId(ws);
    const batchName =
      name.trim() ||
      (valid.length === 1
        ? valid[0]!.file.name.replace(/\.pdf$/i, "")
        : `${valid.length} invoices · ${new Date().toLocaleDateString("en-GB")}`);
    setRun({ stage: 0, progress: 0 });
    try {
      const res = await demoEngine.run(
        { batchId: id, name: batchName, files: valid.map((v) => v.file), prefs: ws.prefs },
        (stage, progress) => setRun({ stage, progress }),
      );
      actions.addBatch(res.batch, res.invoices);
      toast.success(`${res.invoices.length} demo invoices ready for review`);
      navigate({ to: "/app/batches/$id", params: { id } });
    } catch (e) {
      setRun(null);
      setError(e instanceof Error ? e.message : "Processing failed. Please try again.");
    }
  }

  return (
    <div className="mx-auto max-w-[1080px] px-5 py-8 md:px-10 md:py-14">
      <p className="eyebrow">New batch</p>
      <h1 className="display mt-5 text-[52px] md:text-[72px]">
        Bring your documents <em>in.</em>
      </h1>
      <p className="mt-4 max-w-lg text-muted-foreground">
        Upload combined PDFs or multiple individual invoices to start a new batch.
      </p>

      <div className="mt-6 flex items-start gap-2.5 rounded-md border border-warning/30 bg-warning/8 px-4 py-3 text-[13px]">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          Prototype: your files stay in this browser and are not read. Processing is simulated and
          produces <strong className="font-medium">demonstration invoices</strong>, not values from
          your documents.
        </p>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_320px]">
        <div>
          {run ? (
            <ProcessingProgress stage={run.stage} progress={run.progress} />
          ) : (
            <FileDrop
              files={files}
              onAdd={add}
              onRemove={(id) => setFiles((f) => f.filter((x) => x.id !== id))}
            />
          )}
          {error && (
            <p className="mt-4 rounded-md bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
              {error}
            </p>
          )}
        </div>
        <aside className="space-y-8">
          <div>
            <label className="text-[12.5px] text-muted-foreground" htmlFor="bn">
              Batch name <span className="opacity-60">(optional)</span>
            </label>
            <Input
              id="bn"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="November vendor bills"
              className="mt-2 bg-surface"
              disabled={!!run}
            />
          </div>
          <div>
            <p className="eyebrow mb-3">Processing preferences</p>
            <ul className="border-t border-border">
              {PREFS.map((p) => (
                <li
                  key={p.key}
                  className="flex items-start justify-between gap-4 border-b border-border py-3.5"
                >
                  <label htmlFor={p.key} className="cursor-pointer">
                    <p className="text-[13.5px]">{p.label}</p>
                    <p className="text-[12px] text-muted-foreground">{p.hint}</p>
                  </label>
                  <Switch
                    id={p.key}
                    checked={ws.prefs[p.key]}
                    onCheckedChange={(v) => actions.setPrefs({ [p.key]: v })}
                    disabled={!!run}
                  />
                </li>
              ))}
            </ul>
          </div>
          <div className="sticky bottom-20 lg:static">
            <Button
              variant="ink"
              size="lg"
              className="w-full"
              disabled={!valid.length || !!run}
              onClick={start}
            >
              {run
                ? "Processing…"
                : valid.length
                  ? `Process ${valid.length} file${valid.length > 1 ? "s" : ""}`
                  : "Add files to continue"}
              {!run && <ArrowRight />}
            </Button>
            {files.length > valid.length && (
              <p className="mt-2 text-[12px] text-destructive">
                {files.length - valid.length} file(s) will be skipped.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
