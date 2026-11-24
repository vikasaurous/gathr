/**
 * Client-side workspace store shared across routes. In-memory only; swap the
 * mutators for backend calls when persistence is added.
 */
import { useSyncExternalStore } from "react";
import { buildDemoState } from "./demo-data";
import type {
  Batch,
  BatchStatus,
  FieldKey,
  Invoice,
  InvoiceStatus,
  ProcessingPreferences,
} from "./types";
import { approvalGate, evaluateApproval, type ApprovalConfirmation } from "./validation";

export interface WorkspaceState {
  batches: Batch[];
  invoices: Invoice[];
  prefs: ProcessingPreferences;
  filenameTemplate: string;
  workspaceName: string;
}

const initial = (): WorkspaceState => ({
  ...buildDemoState(),
  prefs: {
    detectInvoices: true,
    detectDuplicates: true,
    extractGst: true,
    extractVendor: true,
    autoName: true,
    exportFormat: "csv",
  },
  filenameTemplate: "{vendor}_{invoice_number}_{date}.pdf",
  workspaceName: "Mehta & Co. Accounting",
});

let state = initial();
let boundUserId: string | null = null;
const listeners = new Set<() => void>();
const serverSnapshot = initial();

function set(fn: (s: WorkspaceState) => WorkspaceState) {
  state = fn(state);
  listeners.forEach((l) => l());
}

export function getWorkspaceState(): WorkspaceState {
  return state;
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

function applyFieldValues(
  inv: Invoice,
  values: Partial<Record<FieldKey, string>>,
): { fields: Invoice["fields"]; changed: number } {
  const fields = { ...inv.fields };
  let changed = 0;
  for (const [k, v] of Object.entries(values) as [FieldKey, string | undefined][]) {
    if (v === undefined) continue;
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
  return { fields, changed };
}

export type ApproveInvoiceResult =
  | { ok: true; alreadyVerified: boolean; gate: ReturnType<typeof approvalGate> }
  | {
      ok: false;
      reason: "not_found" | "blocking_errors" | "needs_confirmation" | "stale_warnings";
      gate?: ReturnType<typeof approvalGate> | undefined;
      expectedWarningsFingerprint?: string | undefined;
    };

export const actions = {
  addBatch(batch: Batch, invoices: Invoice[]) {
    set((s) =>
      withBatches({
        ...s,
        batches: [batch, ...s.batches.filter((b) => b.id !== batch.id)],
        invoices: [...invoices, ...s.invoices],
      }),
    );
  },
  putProcessingBatch(batch: Batch) {
    set((s) => ({ ...s, batches: [batch, ...s.batches] }));
  },
  failBatch(id: string, error: string) {
    set((s) => ({
      ...s,
      batches: s.batches.map((b) => (b.id === id ? { ...b, status: "failed", error } : b)),
    }));
  },
  deleteBatch(id: string) {
    set((s) => ({
      ...s,
      batches: s.batches.filter((b) => b.id !== id),
      invoices: s.invoices.filter((i) => i.batchId !== id),
    }));
  },
  saveFields(id: string, values: Partial<Record<FieldKey, string>>) {
    set((s) => ({
      ...s,
      invoices: s.invoices.map((inv) => {
        if (inv.id !== id) return inv;
        const { fields, changed } = applyFieldValues(inv, values);
        if (!changed) return inv;
        const now = stamp();
        return {
          ...inv,
          fields,
          updatedAt: now,
          history: [
            ...inv.history,
            { at: now, action: `Corrected ${changed} field${changed > 1 ? "s" : ""}` },
          ],
        };
      }),
    }));
  },
  approveInvoice(
    id: string,
    values?: Partial<Record<FieldKey, string>>,
    confirmation?: ApprovalConfirmation,
  ): ApproveInvoiceResult {
    const target = state.invoices.find((i) => i.id === id);
    if (!target) return { ok: false, reason: "not_found" };

    const { fields, changed } = values
      ? applyFieldValues(target, values)
      : { fields: target.fields, changed: 0 };
    const candidate: Invoice = changed > 0 ? { ...target, fields } : target;
    const decision = evaluateApproval(candidate, state.invoices, confirmation);
    if (!decision.ok) {
      return {
        ok: false,
        reason: decision.reason,
        gate: decision.gate,
        expectedWarningsFingerprint: decision.expectedWarningsFingerprint,
      };
    }

    if (target.status === "verified" && changed === 0) {
      return { ok: true, alreadyVerified: true, gate: decision.gate };
    }

    const now = stamp();
    set((s) =>
      withBatches({
        ...s,
        invoices: s.invoices.map((inv) => {
          if (inv.id !== id) return inv;
          const next = values ? applyFieldValues(inv, values) : { fields: inv.fields, changed: 0 };
          const history = [...inv.history];
          if (next.changed > 0) {
            history.push({
              at: now,
              action: `Corrected ${next.changed} field${next.changed > 1 ? "s" : ""}`,
            });
          }
          if (inv.status !== "verified") {
            history.push({ at: now, action: "Approved" });
          }
          return {
            ...inv,
            fields: next.fields,
            status: "verified",
            updatedAt: now,
            history,
          };
        }),
      }),
    );

    return { ok: true, alreadyVerified: false, gate: decision.gate };
  },
  setStatus(id: string, status: InvoiceStatus) {
    const label: Record<InvoiceStatus, string> = {
      verified: "Approved",
      duplicate: "Marked as duplicate",
      skipped: "Skipped",
      needs_review: "Returned to review",
    };
    set((s) =>
      withBatches({
        ...s,
        invoices: s.invoices.map((i) => {
          if (i.id !== id || i.status === status) return i;
          if (status === "verified" && !evaluateApproval(i, s.invoices).ok) {
            return i;
          }
          const now = stamp();
          return {
            ...i,
            status,
            updatedAt: now,
            history: [...i.history, { at: now, action: label[status] }],
          };
        }),
      }),
    );
  },
  rename(id: string, fileName: string) {
    set((s) => ({
      ...s,
      invoices: s.invoices.map((i) =>
        i.id === id
          ? {
              ...i,
              fileName,
              history: [...i.history, { at: stamp(), action: `Renamed to ${fileName}` }],
            }
          : i,
      ),
    }));
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
  /**
   * Ties the in-memory workspace state to one signed-in user. If a different
   * user is bound (e.g. after a session expired and someone else signed in on
   * the same tab), the previous user's state is discarded.
   */
  bindUser(userId: string) {
    if (boundUserId !== null && boundUserId !== userId) {
      set(() => initial());
    }
    boundUserId = userId;
  },
  /** Clears all workspace state and the user binding (call on sign-out). */
  release() {
    boundUserId = null;
    set(() => initial());
  },
};

export function nextBatchId(s: WorkspaceState) {
  const max = Math.max(1000, ...s.batches.map((b) => Number(b.id.replace(/\D/g, "")) || 0));
  return `B-${max + 1}`;
}
