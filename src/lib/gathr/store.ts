/**
 * Client-side workspace store shared across routes. In-memory only; swap the
 * mutators for backend calls when persistence is added.
 */
import { useSyncExternalStore } from "react";
import { buildDemoState } from "./demo-data";
import type { Batch, BatchStatus, FieldKey, Invoice, InvoiceStatus, ProcessingPreferences } from "./types";

export interface WorkspaceState {
  batches: Batch[];
  invoices: Invoice[];
  prefs: ProcessingPreferences;
  filenameTemplate: string;
  workspaceName: string;
}

const initial = (): WorkspaceState => ({
  ...buildDemoState(),
  prefs: { detectInvoices: true, detectDuplicates: true, extractGst: true, extractVendor: true, autoName: true, exportFormat: "csv" },
  filenameTemplate: "{vendor}_{invoice_number}_{date}.pdf",
  workspaceName: "Mehta & Co. Accounting",
});

let state = initial();
const listeners = new Set<() => void>();
const serverSnapshot = initial();

function set(fn: (s: WorkspaceState) => WorkspaceState) {
  state = fn(state);
  listeners.forEach((l) => l());
}

export function useWorkspace() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
    () => serverSnapshot,
  );
}

function recomputeBatch(b: Batch, invoices: Invoice[]): BatchStatus {
  if (b.status === "processing" || b.status === "failed") return b.status;
  const own = invoices.filter((i) => i.batchId === b.id);
  return own.some((i) => i.status === "needs_review") ? "needs_review" : "completed";
}

function withBatches(s: WorkspaceState): WorkspaceState {
  return { ...s, batches: s.batches.map((b) => ({ ...b, status: recomputeBatch(b, s.invoices) })) };
}

const stamp = () => new Date().toISOString();

export const actions = {
  addBatch(batch: Batch, invoices: Invoice[]) {
    set((s) => withBatches({ ...s, batches: [batch, ...s.batches.filter((b) => b.id !== batch.id)], invoices: [...invoices, ...s.invoices] }));
  },
  putProcessingBatch(batch: Batch) {
    set((s) => ({ ...s, batches: [batch, ...s.batches] }));
  },
  failBatch(id: string, error: string) {
    set((s) => ({ ...s, batches: s.batches.map((b) => (b.id === id ? { ...b, status: "failed", error } : b)) }));
  },
  deleteBatch(id: string) {
    set((s) => ({ ...s, batches: s.batches.filter((b) => b.id !== id), invoices: s.invoices.filter((i) => i.batchId !== id) }));
  },
  saveFields(id: string, values: Partial<Record<FieldKey, string>>) {
    set((s) => ({
      ...s,
      invoices: s.invoices.map((inv) => {
        if (inv.id !== id) return inv;
        const fields = { ...inv.fields };
        let changed = 0;
        for (const [k, v] of Object.entries(values) as [FieldKey, string][]) {
          const cur = fields[k];
          if (cur.value === v) continue;
          changed++;
          fields[k] = {
            value: v,
            confidence: cur.confidence,
            source: v.trim() ? "corrected" : "missing",
            originalValue: cur.originalValue ?? cur.value,
          };
        }
        if (!changed) return inv;
        return { ...inv, fields, updatedAt: stamp(), history: [...inv.history, { at: stamp(), action: `Corrected ${changed} field${changed > 1 ? "s" : ""}` }] };
      }),
    }));
  },
  setStatus(id: string, status: InvoiceStatus) {
    const label: Record<InvoiceStatus, string> = { verified: "Approved", duplicate: "Marked as duplicate", skipped: "Skipped", needs_review: "Returned to review" };
    set((s) =>
      withBatches({
        ...s,
        invoices: s.invoices.map((i) => (i.id === id ? { ...i, status, updatedAt: stamp(), history: [...i.history, { at: stamp(), action: label[status] }] } : i)),
      }),
    );
  },
  rename(id: string, fileName: string) {
    set((s) => ({ ...s, invoices: s.invoices.map((i) => (i.id === id ? { ...i, fileName, history: [...i.history, { at: stamp(), action: `Renamed to ${fileName}` }] } : i)) }));
  },
  setPrefs(prefs: Partial<ProcessingPreferences>) {
    set((s) => ({ ...s, prefs: { ...s.prefs, ...prefs } }));
  },
  setTemplate(t: string) {
    set((s) => ({ ...s, filenameTemplate: t }));
  },
  setWorkspaceName(n: string) {
    set((s) => ({ ...s, workspaceName: n }));
  },
  reset() {
    set(() => initial());
  },
};

export function nextBatchId(s: WorkspaceState) {
  const max = Math.max(1000, ...s.batches.map((b) => Number(b.id.replace(/\D/g, "")) || 0));
  return `B-${max + 1}`;
}
