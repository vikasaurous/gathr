import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateInvoice } from "@/lib/gathr/demo-data";
import { actions, getWorkspaceState } from "@/lib/gathr/store";
import type { Batch, Invoice } from "@/lib/gathr/types";
import { BatchReviewWorkspace } from "@/routes/app.batches.$id";

const mockToast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
);

vi.mock("sonner", () => ({
  toast: mockToast,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({
    children,
    to,
    ...props
  }: {
    children: ReactNode;
    to: string;
    [key: string]: unknown;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

function makeTestBatch(id: string, invoices: Invoice[]): Batch {
  const filesMap = new Map<string, number>();
  for (const inv of invoices) {
    const maxPage = Math.max(...inv.pages, 1);
    filesMap.set(inv.sourceFile, Math.max(filesMap.get(inv.sourceFile) ?? 0, maxPage));
  }
  return {
    id,
    name: `Test Batch ${id}`,
    createdAt: "2026-11-05T10:00:00Z",
    status: invoices.some((i) => i.status === "needs_review") ? "needs_review" : "completed",
    files: [...filesMap.entries()].map(([name, pageCount]) => ({
      name,
      size: 100_000,
      pageCount,
    })),
    invoiceIds: invoices.map((i) => i.id),
    isDemo: false,
  };
}

function makeCleanInvoice(id: string, batchId: string, seed = 5): Invoice {
  const inv = generateInvoice(id, {
    batchId,
    sourceFile: `${id}.pdf`,
    startPage: 1,
    seed,
    baseDate: "2026-11-05T10:00:00Z",
  });
  inv.fields.taxableValue.value = "1000.00";
  inv.fields.cgst.value = "90.00";
  inv.fields.sgst.value = "90.00";
  inv.fields.igst.value = "0.00";
  inv.fields.total.value = "1180.00";
  return inv;
}

function seedWorkspaceBatch(batchId: string, invoices: Invoice[]) {
  const batch = makeTestBatch(batchId, invoices);
  actions.addBatch(batch, invoices);
  return batch;
}

function invokeReactClick(el: HTMLElement) {
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("Missing React props key");
  const props = Reflect.get(el, propsKey) as { onClick?: () => void };
  props.onClick?.();
}

vi.setConfig({ testTimeout: 15_000 });

describe("Invoice Review Guardrails UI & Workflow", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    actions.reset();
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("renders demo batch review screen without SSR or console errors and keeps export unaffected", () => {
    const html = renderToString(
      <BatchReviewWorkspace batchId="B-1042" invoiceId="B-1042-001" onSelectInvoice={vi.fn()} />,
    );
    expect(html).toContain("October vendor bills");
    expect(html).not.toContain("No invoices in this batch.");

    render(
      <BatchReviewWorkspace batchId="B-1042" invoiceId="B-1042-001" onSelectInvoice={vi.fn()} />,
    );
    expect(screen.getByText("October vendor bills")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Export/i }));
    expect(screen.getByText("Export records")).toBeInTheDocument();
  });

  it("blocks approval when blocking errors exist and rejects direct handler invocation", () => {
    const inv = makeCleanInvoice("INV-ERR-1", "B-ERR");
    inv.fields.invoiceNumber.value = "";
    inv.fields.gstin.value = "INVALID";
    seedWorkspaceBatch("B-ERR", [inv]);

    render(
      <BatchReviewWorkspace batchId="B-ERR" invoiceId="INV-ERR-1" onSelectInvoice={vi.fn()} />,
    );

    expect(
      screen.getByText("2 blocking errors must be corrected before this invoice can be approved."),
    ).toBeInTheDocument();

    const approveBtn = screen.getByRole("button", { name: "Fix 2 errors to approve" });
    expect(approveBtn).toBeDisabled();

    // Direct store handler invocation must independently reject
    act(() => {
      const directRes = actions.approveInvoice("INV-ERR-1", {
        invoiceNumber: "",
        gstin: "INVALID",
      });
      expect(directRes).toMatchObject({ ok: false, reason: "blocking_errors" });
      actions.setStatus("INV-ERR-1", "verified");
    });
    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-ERR-1")?.status).toBe(
      "needs_review",
    );

    // Bypassing disabled attribute/prop on DOM button still triggers component approval guard
    act(() => {
      invokeReactClick(approveBtn);
    });
    expect(mockToast.error).toHaveBeenCalledWith("Correct the blocking errors before approving.");
    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-ERR-1")?.status).toBe(
      "needs_review",
    );
  });

  it("recalculates validation immediately on edit and allows approval once blocking errors are fixed", () => {
    const inv = makeCleanInvoice("INV-FIX-1", "B-FIX");
    inv.fields.invoiceNumber.value = "";
    seedWorkspaceBatch("B-FIX", [inv]);

    render(
      <BatchReviewWorkspace batchId="B-FIX" invoiceId="INV-FIX-1" onSelectInvoice={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Fix 1 error to approve" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Invoice number"), {
      target: { value: "INV-2026-009" },
    });

    const approveBtn = screen.getByRole("button", { name: "Approve invoice" });
    expect(approveBtn).toBeEnabled();

    fireEvent.click(approveBtn);

    const updated = getWorkspaceState().invoices.find((i) => i.id === "INV-FIX-1");
    expect(updated?.status).toBe("verified");
    expect(updated?.fields.invoiceNumber.value).toBe("INV-2026-009");
    expect(getWorkspaceState().batches.find((b) => b.id === "B-FIX")?.status).toBe("completed");
  });

  it("flags malformed monetary amounts immediately on edit and prevents approval", () => {
    const inv = makeCleanInvoice("INV-MON-1", "B-MON");
    seedWorkspaceBatch("B-MON", [inv]);

    render(
      <BatchReviewWorkspace batchId="B-MON" invoiceId="INV-MON-1" onSelectInvoice={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Approve invoice" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Total amount"), {
      target: { value: "abc" },
    });

    expect(
      screen.getAllByText("Total amount is not a valid amount.").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Fix 1 error to approve" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Total amount"), {
      target: { value: "1,180.00" },
    });
    expect(screen.getByRole("button", { name: "Approve invoice" })).toBeEnabled();
  });

  it("requires explicit warning confirmation, preserves draft on cancel, and approves on confirm", () => {
    const inv = makeCleanInvoice("INV-WARN-1", "B-WARN");
    inv.fields.cgst.value = "100.00";
    inv.fields.sgst.value = "80.00";
    seedWorkspaceBatch("B-WARN", [inv]);

    render(
      <BatchReviewWorkspace batchId="B-WARN" invoiceId="INV-WARN-1" onSelectInvoice={vi.fn()} />,
    );

    // Direct handler invocation cannot bypass warning confirmation
    act(() => {
      expect(actions.approveInvoice("INV-WARN-1")).toMatchObject({
        ok: false,
        reason: "needs_confirmation",
      });
      expect(
        actions.approveInvoice("INV-WARN-1", undefined, { confirmedWarnings: true }),
      ).toMatchObject({
        ok: false,
        reason: "stale_warnings",
      });
      actions.setStatus("INV-WARN-1", "verified");
    });
    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-WARN-1")?.status).toBe(
      "needs_review",
    );

    // Edit supplier draft before opening confirmation dialog
    fireEvent.change(screen.getByLabelText("Supplier name"), {
      target: { value: "Updated Supplier Pvt Ltd" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Review 1 warning & approve" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Approve with warnings?")).toBeInTheDocument();
    expect(within(dialog).getByText(/CGST and SGST are usually equal\./)).toBeInTheDocument();

    // Cancel keeps invoice unapproved and preserves unsaved draft
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep reviewing" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-WARN-1")?.status).toBe(
      "needs_review",
    );
    expect(screen.getByLabelText("Supplier name")).toHaveValue("Updated Supplier Pvt Ltd");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    // Confirm approves invoice and saves draft
    fireEvent.click(screen.getByRole("button", { name: "Review 1 warning & approve" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Approve anyway" }),
    );

    const verified = getWorkspaceState().invoices.find((i) => i.id === "INV-WARN-1");
    expect(verified?.status).toBe("verified");
    expect(verified?.fields.supplier.value).toBe("Updated Supplier Pvt Ltd");
  });

  it("rejects stale warning confirmation when warnings or errors change while dialog is open", () => {
    const a = makeCleanInvoice("INV-STALE-1", "B-STALE", 5);
    a.fields.invoiceNumber.value = "INV-OTHER";
    const b = makeCleanInvoice("INV-STALE-2", "B-STALE", 12);
    b.fields.invoiceNumber.value = "INV-900";
    b.fields.cgst.value = "100.00";
    b.fields.sgst.value = "80.00";
    seedWorkspaceBatch("B-STALE", [a, b]);

    render(
      <BatchReviewWorkspace batchId="B-STALE" invoiceId="INV-STALE-2" onSelectInvoice={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review 1 warning & approve" }));
    expect(
      within(screen.getByRole("dialog")).getByText(/CGST and SGST are usually equal\./),
    ).toBeInTheDocument();

    // Concurrent store change adds a new duplicate_candidate warning while dialog is open
    act(() => {
      actions.saveFields("INV-STALE-1", {
        invoiceNumber: "INV-900",
        gstin: b.fields.gstin.value,
      });
    });

    // Clicking Approve anyway against stale warning snapshot must NOT approve
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Approve anyway" }),
    );

    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-STALE-2")?.status).toBe(
      "needs_review",
    );
    const refreshedDialog = screen.getByRole("dialog");
    expect(
      within(refreshedDialog).getByText(/Validation warnings changed while this dialog was open/),
    ).toBeInTheDocument();
    expect(within(refreshedDialog).getByText(/Possible duplicate of/)).toBeInTheDocument();

    // If a blocking error appears while dialog is open, confirming is rejected
    act(() => {
      actions.saveFields("INV-STALE-2", { invoiceNumber: "" });
    });
    expect(
      within(screen.getByRole("dialog")).getByText(/Blocking errors were detected/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Approve anyway" }),
    );
    expect(mockToast.error).toHaveBeenCalledWith("Correct the blocking errors before approving.");
    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-STALE-2")?.status).toBe(
      "needs_review",
    );

    // Fix the blocking error and confirm the updated warnings explicitly
    fireEvent.change(screen.getByLabelText("Invoice number"), {
      target: { value: "INV-900" },
    });
    fireEvent.click(screen.getByRole("button", { name: /warning.*approve/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Approve anyway" }),
    );
    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-STALE-2")?.status).toBe(
      "verified",
    );
  });

  it("navigates to and focuses field-specific issues while keeping non-field issues non-clickable", () => {
    const a = makeCleanInvoice("INV-NAV-1", "B-NAV", 5);
    const b = makeCleanInvoice("INV-NAV-2", "B-NAV", 5);
    b.fields.gstin.value = "BADGSTIN";
    b.fields.supplier.value = a.fields.supplier.value;
    b.fields.invoiceNumber.value = a.fields.invoiceNumber.value;
    seedWorkspaceBatch("B-NAV", [a, b]);

    const { unmount } = render(
      <BatchReviewWorkspace batchId="B-NAV" invoiceId="INV-NAV-2" onSelectInvoice={vi.fn()} />,
    );

    // Non-field duplicate candidate is readable but not a button
    expect(screen.getByText(/Possible duplicate of/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Possible duplicate/i })).not.toBeInTheDocument();

    const gstinInput = screen.getByLabelText("GSTIN");
    const scrollSpy = vi.fn();
    gstinInput.scrollIntoView = scrollSpy;

    // Switch to Document tab first (mobile flow) then click field issue
    fireEvent.click(screen.getByRole("button", { name: "Document" }));
    fireEvent.click(screen.getByRole("button", { name: /Go to GSTIN:/i }));

    expect(scrollSpy).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(document.activeElement).toBe(gstinInput);

    unmount();
  });

  it("supports clean approval, save, skip, duplicate, return to review, prev/next, and prevents duplicate history on repeated clicks", async () => {
    const inv1 = makeCleanInvoice("INV-FLOW-1", "B-FLOW", 5);
    const inv2 = makeCleanInvoice("INV-FLOW-2", "B-FLOW", 9);
    const inv3 = makeCleanInvoice("INV-FLOW-3", "B-FLOW", 14);
    seedWorkspaceBatch("B-FLOW", [inv1, inv2, inv3]);

    const onSelectInvoice = vi.fn();
    const { rerender } = render(
      <BatchReviewWorkspace
        batchId="B-FLOW"
        invoiceId="INV-FLOW-1"
        onSelectInvoice={onSelectInvoice}
      />,
    );

    // Save action works
    fireEvent.change(screen.getByLabelText("Supplier name"), {
      target: { value: "Saved Supplier" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      getWorkspaceState().invoices.find((i) => i.id === "INV-FLOW-1")?.fields.supplier.value,
    ).toBe("Saved Supplier");

    // Prev / Next navigation works
    expect(screen.getByRole("button", { name: "Previous invoice" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next invoice" }));
    expect(onSelectInvoice).toHaveBeenCalledWith("INV-FLOW-2");

    // Approve clean invoice directly -> advances to next needs_review
    onSelectInvoice.mockClear();
    mockToast.success.mockClear();
    const approveBtn = screen.getByRole("button", { name: "Approve invoice" });
    fireEvent.click(approveBtn);
    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-FLOW-1")?.status).toBe(
      "verified",
    );
    expect(onSelectInvoice).toHaveBeenCalledWith("INV-FLOW-2");

    // Repeated UI clicks and repeated direct approval calls do not create duplicate history entries
    act(() => {
      invokeReactClick(approveBtn);
      invokeReactClick(approveBtn);
      actions.approveInvoice("INV-FLOW-1");
      actions.approveInvoice("INV-FLOW-1");
    });
    const inv1History = getWorkspaceState().invoices.find((i) => i.id === "INV-FLOW-1")?.history;
    expect(inv1History?.filter((h) => h.action === "Approved")).toHaveLength(1);
    expect(mockToast.success).toHaveBeenCalledTimes(1);

    // Progress bar and footer Next button navigation work
    onSelectInvoice.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onSelectInvoice).toHaveBeenCalledWith("INV-FLOW-2");
    const progressBar = screen.getByLabelText("Review progress");
    const progressButtons = within(progressBar).getAllByRole("button");
    expect(progressButtons).toHaveLength(3);
    fireEvent.click(progressButtons[2]!);
    expect(onSelectInvoice).toHaveBeenCalledWith("INV-FLOW-3");

    // Return to review works and repeated calls do not duplicate history
    fireEvent.click(screen.getByRole("button", { name: "Return to review" }));
    act(() => {
      actions.setStatus("INV-FLOW-1", "needs_review");
    });
    const inv1Returned = getWorkspaceState().invoices.find((i) => i.id === "INV-FLOW-1");
    expect(inv1Returned?.status).toBe("needs_review");
    expect(inv1Returned?.history.filter((h) => h.action === "Returned to review")).toHaveLength(1);
    expect(getWorkspaceState().batches.find((b) => b.id === "B-FLOW")?.status).toBe("needs_review");

    // Re-approve inv1, then switch to inv2 and Skip
    fireEvent.click(screen.getByRole("button", { name: "Approve invoice" }));
    rerender(
      <BatchReviewWorkspace
        batchId="B-FLOW"
        invoiceId="INV-FLOW-2"
        onSelectInvoice={onSelectInvoice}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(getWorkspaceState().invoices.find((i) => i.id === "INV-FLOW-2")?.status).toBe("skipped");

    // Switch to inv3 and Mark duplicate
    rerender(
      <BatchReviewWorkspace
        batchId="B-FLOW"
        invoiceId="INV-FLOW-3"
        onSelectInvoice={onSelectInvoice}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark duplicate" }));
    const alertDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(alertDialog).getByRole("button", { name: "Mark duplicate" }));
    await waitFor(() => {
      expect(getWorkspaceState().invoices.find((i) => i.id === "INV-FLOW-3")?.status).toBe(
        "duplicate",
      );
    });
    expect(getWorkspaceState().batches.find((b) => b.id === "B-FLOW")?.status).toBe("completed");
  });
});
