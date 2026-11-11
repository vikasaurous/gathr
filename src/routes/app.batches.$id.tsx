import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Minus,
  Pencil,
  Plus,
  Save,
  SkipForward,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog, EmptyState } from "@/components/gathr/common";
import { DocumentPage } from "@/components/gathr/document-page";
import { ExportDialog } from "@/components/gathr/export-dialog";
import { InvoiceFields } from "@/components/gathr/invoice-fields";
import { BatchStatusPill, DemoBadge, InvoiceStatusPill } from "@/components/gathr/status";
import { buildFileName } from "@/lib/gathr/export";
import { formatMoney, pageRange } from "@/lib/gathr/format";
import { actions, getWorkspaceState, useWorkspace } from "@/lib/gathr/store";
import { FIELD_META, type FieldKey, type Invoice, type ValidationIssue } from "@/lib/gathr/types";
import {
  approvalGate,
  evaluateApproval,
  validateInvoice,
  warningFingerprint,
  type ApprovalConfirmation,
} from "@/lib/gathr/validation";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/batches/$id")({
  validateSearch: (s: Record<string, unknown>): { invoice?: string | undefined } => ({
    invoice: typeof s["invoice"] === "string" ? s["invoice"] : undefined,
  }),
  head: ({ params }) => ({
    meta: [
      { title: `Review ${params.id} — gathr` },
      {
        name: "description",
        content: "Review extracted invoice information against the source document.",
      },
      { property: "og:title", content: `Review ${params.id} — gathr` },
      {
        property: "og:description",
        content: "Review extracted invoice information against the source document.",
      },
    ],
  }),
  component: Review,
});

const draftOf = (inv: Invoice): Record<FieldKey, string> =>
  Object.fromEntries(Object.entries(inv.fields).map(([k, v]) => [k, v.value])) as Record<
    FieldKey,
    string
  >;

const withDraftFields = (inv: Invoice, draft: Record<FieldKey, string>): Invoice => ({
  ...inv,
  fields: Object.fromEntries(
    Object.entries(inv.fields).map(([k, v]) => [k, { ...v, value: draft[k as FieldKey] }]),
  ) as Invoice["fields"],
});

interface WarningConfirmState {
  fingerprint: string;
  warnings: ValidationIssue[];
  staleNotice: boolean;
}

function Review() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <BatchReviewWorkspace
      batchId={id}
      invoiceId={search.invoice}
      onSelectInvoice={(invoice) => navigate({ search: { invoice }, replace: true })}
    />
  );
}

export function BatchReviewWorkspace({
  batchId,
  invoiceId,
  onSelectInvoice,
}: {
  batchId: string;
  invoiceId?: string | undefined;
  onSelectInvoice: (id: string) => void;
}) {
  const ws = useWorkspace();
  const batch = ws.batches.find((b) => b.id === batchId);
  const invoices = useMemo(
    () =>
      ws.invoices
        .filter((i) => i.batchId === batchId)
        .sort(
          (a, b) =>
            a.sourceFile.localeCompare(b.sourceFile) || (a.pages[0] ?? 0) - (b.pages[0] ?? 0),
        ),
    [ws.invoices, batchId],
  );
  const current =
    invoices.find((i) => i.id === invoiceId) ??
    invoices.find((i) => i.status === "needs_review") ??
    invoices[0];
  const idx = current ? invoices.indexOf(current) : -1;

  const [draftState, setDraftState] = useState<{
    invoiceId: string;
    values: Record<FieldKey, string>;
  } | null>(null);
  const [focus, setFocus] = useState<FieldKey | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState<"doc" | "fields">("fields");
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [warningConfirm, setWarningConfirm] = useState<WarningConfirmState | null>(null);
  const [pendingFocus, setPendingFocus] = useState<{ key: FieldKey; seq: number } | null>(null);
  const focusSeqRef = useRef(0);
  const handledFocusSeqRef = useRef(0);

  const draft = current
    ? draftState?.invoiceId === current.id
      ? draftState.values
      : draftOf(current)
    : null;
  const draftRef = useRef<Record<FieldKey, string> | null>(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!current) return;
    setDraftState(null);
    setPage(current.pages[0] ?? 1);
    setWarningConfirm(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  useEffect(() => {
    if (!pendingFocus || tab !== "fields" || pendingFocus.seq === handledFocusSeqRef.current) {
      return;
    }
    if (typeof document === "undefined") return;
    const el = document.getElementById(`f-${pendingFocus.key}`);
    if (!el) return;
    handledFocusSeqRef.current = pendingFocus.seq;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    if (el instanceof HTMLElement) {
      el.focus({ preventScroll: true });
    }
  }, [pendingFocus, tab]);

  if (!batch)
    return (
      <div className="p-10">
        <EmptyState
          title="Batch not found."
          action={
            <Button variant="outline" asChild>
              <Link to="/app/batches">Back to batches</Link>
            </Button>
          }
        >
          It may have been deleted.
        </EmptyState>
      </div>
    );
  if (batch.status === "failed")
    return (
      <div className="p-10">
        <EmptyState
          title="This batch could not be processed."
          action={
            <Button variant="ink" asChild>
              <Link to="/app/new">Try a new upload</Link>
            </Button>
          }
        >
          {batch.error}
        </EmptyState>
      </div>
    );
  if (!current || !draft)
    return (
      <div className="p-10">
        <EmptyState title="No invoices in this batch." />
      </div>
    );

  const live = withDraftFields(current, draft);
  const issues = validateInvoice(live, ws.invoices);
  const dirty = (Object.keys(draft) as FieldKey[]).some(
    (k) => draft[k] !== current.fields[k].value,
  );
  const gate = approvalGate(issues);
  const errors = gate.blocking.length;
  const fieldLabel = (k?: FieldKey) => (k ? FIELD_META.find((m) => m.key === k)?.label : undefined);

  const focusField = (k?: FieldKey) => {
    if (!k) return;
    setTab("fields");
    focusSeqRef.current += 1;
    setPendingFocus({ key: k, seq: focusSeqRef.current });
  };

  const file = batch.files.find((f) => f.name === current.sourceFile) ?? batch.files[0]!;
  const fileInvoices = invoices.filter((i) => i.sourceFile === file.name);
  const pageOwner = fileInvoices.find((i) => i.pages.includes(page));

  const go = (i: number) => {
    const activeDraft = draftRef.current ?? draft;
    const hasUnsaved = (Object.keys(activeDraft) as FieldKey[]).some(
      (k) => activeDraft[k] !== current.fields[k].value,
    );
    if (hasUnsaved) actions.saveFields(current.id, activeDraft);
    const t = invoices[Math.max(0, Math.min(invoices.length - 1, i))];
    if (!t) return;
    onSelectInvoice(t.id);
  };

  const save = () => {
    const activeDraft = draftRef.current ?? draft;
    actions.saveFields(current.id, activeDraft);
    setDraftState(null);
    toast.success("Corrections saved");
  };

  const approve = (confirmation?: ApprovalConfirmation): boolean => {
    const activeDraft = draftRef.current ?? draft;
    const latestState = getWorkspaceState();
    const latestInvoice = latestState.invoices.find((i) => i.id === current.id);
    if (!latestInvoice) return false;

    const latestLive = withDraftFields(latestInvoice, activeDraft);
    const decision = evaluateApproval(latestLive, latestState.invoices, confirmation);

    if (!decision.ok) {
      if (decision.reason === "blocking_errors") {
        setWarningConfirm(null);
        toast.error("Correct the blocking errors before approving.");
        return false;
      }
      const nextWarnings = decision.gate.warnings;
      const nextFingerprint =
        decision.expectedWarningsFingerprint ?? warningFingerprint(nextWarnings);
      setWarningConfirm({
        fingerprint: nextFingerprint,
        warnings: nextWarnings,
        staleNotice: decision.reason === "stale_warnings",
      });
      return false;
    }

    const result = actions.approveInvoice(current.id, activeDraft, confirmation);
    if (!result.ok) {
      if (result.reason === "blocking_errors") {
        setWarningConfirm(null);
        toast.error("Correct the blocking errors before approving.");
      } else if (result.gate) {
        setWarningConfirm({
          fingerprint:
            result.expectedWarningsFingerprint ?? warningFingerprint(result.gate.warnings),
          warnings: result.gate.warnings,
          staleNotice: result.reason === "stale_warnings",
        });
      }
      return false;
    }

    setWarningConfirm(null);
    if (result.alreadyVerified) return true;

    toast.success(`${latestInvoice.fileName} approved`);
    const latestBatchInvoices = latestState.invoices
      .filter((i) => i.batchId === batchId)
      .sort(
        (a, b) => a.sourceFile.localeCompare(b.sourceFile) || (a.pages[0] ?? 0) - (b.pages[0] ?? 0),
      );
    const latestIdx = latestBatchInvoices.findIndex((i) => i.id === current.id);
    const next =
      latestBatchInvoices.slice(latestIdx + 1).find((i) => i.status === "needs_review") ??
      latestBatchInvoices.find((i) => i.status === "needs_review" && i.id !== current.id);
    if (next) onSelectInvoice(next.id);
    return true;
  };

  const handleFieldChange = (k: FieldKey, v: string) => {
    const nextValues = { ...(draftRef.current ?? draft), [k]: v };
    draftRef.current = nextValues;
    setDraftState({ invoiceId: current.id, values: nextValues });
  };

  const reviewed = invoices.filter((i) => i.status !== "needs_review").length;
  const dialogHasBlockingErrors = warningConfirm !== null && !gate.canApprove;

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col lg:h-screen lg:min-h-0">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            to="/app/batches"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Back"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-serif text-[22px] leading-tight">{batch.name}</h1>
              {batch.isDemo && <DemoBadge />}
            </div>
            <p className="num text-[11px] text-muted-foreground">
              {batch.id} · {reviewed}/{invoices.length} reviewed
            </p>
          </div>
          <BatchStatusPill status={batch.status} />
          <ExportDialog invoices={invoices} label={batch.name} />
        </div>
        <div className="mt-3 flex gap-[2px]" aria-label="Review progress">
          {invoices.map((i, n) => (
            <button
              key={i.id}
              onClick={() => go(n)}
              title={`${i.fileName} · ${i.status}`}
              className={cn(
                "h-1.5 flex-1 rounded-[1px] transition-opacity hover:opacity-70",
                i.status === "verified"
                  ? "bg-success"
                  : i.status === "duplicate"
                    ? "bg-destructive/60"
                    : i.status === "skipped"
                      ? "bg-muted-foreground/40"
                      : "bg-border",
                i.id === current.id && "outline outline-1 outline-offset-1 outline-foreground",
              )}
            />
          ))}
        </div>
      </div>

      {/* Mobile tabs */}
      <div className="grid grid-cols-2 border-b border-border lg:hidden">
        {(["doc", "fields"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "py-2.5 text-[13px]",
              tab === t ? "border-b-2 border-foreground" : "text-muted-foreground",
            )}
          >
            {t === "doc" ? "Document" : `Extracted fields${errors ? ` · ${errors}` : ""}`}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
        {/* Document */}
        <section
          className={cn(
            "min-h-0 flex-col border-border bg-secondary lg:flex lg:border-r",
            tab === "doc" ? "flex" : "hidden",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-[12px]">
            <span className="num truncate text-muted-foreground">{file.name}</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous page"
              >
                <ChevronLeft />
              </Button>
              <span className="num w-16 text-center">
                {page} / {file.pageCount}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setPage((p) => Math.min(file.pageCount, p + 1))}
                aria-label="Next page"
              >
                <ChevronRight />
              </Button>
              <span className="mx-1 h-4 w-px bg-border" />
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setZoom((z) => Math.max(0.6, z - 0.2))}
                aria-label="Zoom out"
              >
                <Minus />
              </Button>
              <span className="num w-10 text-center">{Math.round(zoom * 100)}%</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setZoom((z) => Math.min(1.8, z + 0.2))}
                aria-label="Zoom in"
              >
                <Plus />
              </Button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1">
            {/* Page strip with boundaries */}
            <div className="hidden w-[92px] shrink-0 overflow-y-auto border-r border-border p-2 md:block">
              {fileInvoices.map((fi, n) => (
                <div
                  key={fi.id}
                  className={cn(
                    "mb-2 rounded-md border p-1",
                    fi.id === current.id ? "border-primary bg-primary/5" : "border-transparent",
                  )}
                >
                  <p className="num mb-1 px-0.5 text-[9.5px] text-muted-foreground">
                    INV {String(n + 1).padStart(2, "0")}
                  </p>
                  {fi.pages.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        if (fi.id !== current.id) go(invoices.indexOf(fi));
                        setPage(p);
                      }}
                      className={cn(
                        "mb-1 block w-full rounded-[2px] border bg-surface",
                        page === p && fi.id === current.id ? "border-foreground" : "border-border",
                      )}
                    >
                      <div className="aspect-[1/1.414] p-1.5">
                        <div className="h-1 w-3/4 bg-border" />
                        <div className="mt-1 h-0.5 w-1/2 bg-border" />
                      </div>
                      <span className="num block text-[9px] text-muted-foreground">{p}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="min-w-0 flex-1 overflow-auto p-4 md:p-8">
              <div
                className="mx-auto transition-[width] duration-200"
                style={{ width: `${Math.min(100, 72 * zoom)}%`, minWidth: 260 * zoom }}
              >
                {pageOwner && (
                  <DocumentPage
                    invoice={pageOwner.id === current.id ? live : pageOwner}
                    page={page}
                    highlight={pageOwner.id === current.id ? focus : null}
                  />
                )}
                <p className="num mt-3 text-center text-[11px] text-muted-foreground">
                  Page {page} · belongs to{" "}
                  {pageOwner?.id === current.id ? "this invoice" : pageOwner?.fileName} (
                  {pageRange(pageOwner?.pages ?? [])})
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Fields */}
        <section
          className={cn(
            "min-h-0 flex-col bg-background lg:flex",
            tab === "fields" ? "flex" : "hidden",
          )}
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="min-w-0">
              <p className="num text-[11px] text-muted-foreground">
                INVOICE {String(idx + 1).padStart(2, "0")} / {invoices.length} ·{" "}
                {pageRange(current.pages)}
              </p>
              <button
                onClick={() => {
                  setNewName(current.fileName);
                  setRenaming(true);
                }}
                className="group flex max-w-full items-center gap-1.5 text-[14px]"
              >
                <span className="truncate">{current.fileName}</span>
                <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <InvoiceStatusPill status={current.status} />
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={idx <= 0}
                onClick={() => go(idx - 1)}
                aria-label="Previous invoice"
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={idx >= invoices.length - 1}
                onClick={() => go(idx + 1)}
                aria-label="Next invoice"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {issues.length > 0 ? (
              <div className="mb-6 rounded-md border border-border bg-surface">
                <p className="border-b border-border px-3 py-2 text-[12px]">
                  {issues.length} item{issues.length > 1 ? "s" : ""} to check{" "}
                  <span className="text-muted-foreground">
                    · values are never changed automatically
                  </span>
                </p>
                {errors > 0 && (
                  <p className="border-b border-border bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
                    {errors} blocking error{errors > 1 ? "s" : ""} must be corrected before this
                    invoice can be approved.
                  </p>
                )}
                <ul className="px-3 py-2 text-[12.5px]">
                  {issues.map((i, n) => {
                    const label = fieldLabel(i.field);
                    const body = (
                      <>
                        <span
                          className={cn(
                            "mt-1.5 size-1.5 shrink-0 rounded-full",
                            i.severity === "error" ? "bg-destructive" : "bg-warning",
                          )}
                        />
                        <span>
                          {label && <span className="font-medium">{label}: </span>}
                          {i.message}
                          <span className="num ml-1.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                            {i.severity === "error" ? "blocking" : "warning"}
                          </span>
                        </span>
                      </>
                    );
                    return (
                      <li key={n}>
                        {i.field ? (
                          <button
                            type="button"
                            onClick={() => focusField(i.field)}
                            className="flex w-full gap-2 rounded-sm py-1 text-left hover:bg-secondary"
                            aria-label={`Go to ${label}: ${i.message}`}
                          >
                            {body}
                          </button>
                        ) : (
                          <div className="flex gap-2 py-1">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="mb-6 flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-[12.5px] text-success">
                <Check className="size-4" /> No validation issues. Still compare against the
                document before approving.
              </p>
            )}
            <InvoiceFields
              invoice={current}
              draft={draft}
              onChange={handleFieldChange}
              issues={issues}
              onFocusField={setFocus}
            />
            <div className="mt-6 flex justify-between border-t border-border pt-4 text-[12.5px]">
              <span className="text-muted-foreground">Total</span>
              <span className="num">{formatMoney(draft.total, draft.currency || "INR")}</span>
            </div>
            <details className="mt-6 text-[12px] text-muted-foreground">
              <summary className="cursor-pointer">History ({current.history.length})</summary>
              <ul className="num mt-2 space-y-1">
                {current.history.map((h, n) => (
                  <li key={n}>
                    {h.at.slice(0, 16).replace("T", " ")} · {h.action}
                  </li>
                ))}
              </ul>
            </details>
          </div>
          <div className="sticky bottom-[57px] border-t border-border bg-background px-5 py-3 lg:bottom-0">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="default"
                className="flex-1"
                onClick={() => approve()}
                disabled={errors > 0 || (current.status === "verified" && !dirty)}
              >
                <Check />{" "}
                {errors > 0
                  ? `Fix ${errors} error${errors > 1 ? "s" : ""} to approve`
                  : current.status === "verified" && !dirty
                    ? "Approved"
                    : gate.warnings.length
                      ? `Review ${gate.warnings.length} warning${gate.warnings.length > 1 ? "s" : ""} & approve`
                      : "Approve invoice"}
              </Button>
              <Button variant="outline" onClick={save} disabled={!dirty}>
                <Save /> Save
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1 text-[12px]">
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" size="sm" disabled={current.status === "duplicate"}>
                    <Copy /> Mark duplicate
                  </Button>
                }
                title="Mark as duplicate?"
                description="This invoice will be excluded from exports by default. The original document and extracted values are kept."
                confirmLabel="Mark duplicate"
                destructive
                onConfirm={() => {
                  actions.setStatus(current.id, "duplicate");
                  toast("Marked as duplicate");
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  actions.setStatus(current.id, "skipped");
                  go(idx + 1);
                }}
              >
                <SkipForward /> Skip
              </Button>
              {current.status !== "needs_review" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => actions.setStatus(current.id, "needs_review")}
                >
                  Return to review
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                disabled={idx >= invoices.length - 1}
                onClick={() => go(idx + 1)}
              >
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        </section>
      </div>

      <Dialog
        open={warningConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setWarningConfirm(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl font-normal">
              Approve with warnings?
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              Check these before approving. Values will not be changed.
            </DialogDescription>
          </DialogHeader>
          {(warningConfirm?.staleNotice || dialogHasBlockingErrors) && (
            <p
              className={cn(
                "rounded-md border px-3 py-2 text-[12px]",
                dialogHasBlockingErrors
                  ? "border-destructive/30 bg-destructive/5 text-destructive"
                  : "border-warning/40 bg-warning/10 text-warning",
              )}
            >
              {dialogHasBlockingErrors
                ? "Blocking errors were detected and must be corrected before approving."
                : "Validation warnings changed while this dialog was open. Review the updated warnings before confirming."}
            </p>
          )}
          <ul className="space-y-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12.5px]">
            {(warningConfirm?.warnings ?? []).map((w, n) => (
              <li key={n} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
                {fieldLabel(w.field) ? `${fieldLabel(w.field)}: ` : ""}
                {w.message}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setWarningConfirm(null)}>
              Keep reviewing
            </Button>
            <Button
              variant="default"
              onClick={() => {
                if (!warningConfirm) return;
                approve({
                  confirmedWarnings: true,
                  acknowledgedWarnings: warningConfirm.fingerprint,
                });
              }}
            >
              <Check /> Approve anyway
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl font-normal">Rename document</DialogTitle>
            <DialogDescription className="sr-only">
              Enter a new filename for this invoice record.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="num text-[13px]"
          />
          <button
            className="num text-left text-[12px] text-primary hover:underline"
            onClick={() => setNewName(buildFileName(ws.filenameTemplate, live))}
          >
            Use template → {buildFileName(ws.filenameTemplate, live)}
          </button>
          <Button
            variant="ink"
            disabled={!newName.trim()}
            onClick={() => {
              actions.rename(
                current.id,
                newName.trim().endsWith(".pdf") ? newName.trim() : `${newName.trim()}.pdf`,
              );
              setRenaming(false);
              toast.success("Renamed");
            }}
          >
            Save name
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
