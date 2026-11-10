import { describe, expect, it } from "vitest";
import { generateInvoice } from "./demo-data";
import { approvalGate, isValidGstin, validateInvoice } from "./validation";

const base = () =>
  generateInvoice("T-1", { batchId: "T", sourceFile: "t.pdf", startPage: 1, seed: 5, baseDate: "2026-11-01T00:00:00Z" });

describe("invoice validation", () => {
  it("accepts a well-formed 15-character GSTIN and rejects a malformed one", () => {
    expect(isValidGstin("27AABCN4821K1Z6")).toBe(true);
    expect(isValidGstin("27AABCN4821K1Z")).toBe(false);
  });

  it("flags a missing invoice number", () => {
    const inv = base();
    inv.fields.invoiceNumber.value = "";
    expect(validateInvoice(inv).map((i) => i.code)).toContain("missing_invoice_number");
  });

  it("flags a total that differs from taxable value plus tax by more than 1", () => {
    const inv = base();
    inv.fields.total.value = (Number(inv.fields.total.value) + 5).toFixed(2);
    expect(validateInvoice(inv).map((i) => i.code)).toContain("total_mismatch");
  });

  it("does not modify financial values while validating", () => {
    const inv = base();
    inv.fields.total.value = "1.00";
    validateInvoice(inv);
    expect(inv.fields.total.value).toBe("1.00");
  });

  it("blocks approval while a validation error remains", () => {
    const inv = base();
    inv.fields.invoiceNumber.value = "";
    expect(approvalGate(validateInvoice(inv)).canApprove).toBe(false);
  });

  it("allows approval once errors are corrected", () => {
    const inv = base();
    inv.fields.invoiceNumber.value = "";
    inv.fields.invoiceNumber.value = "INV-1";
    expect(approvalGate(validateInvoice(inv)).canApprove).toBe(true);
  });

  it("requires confirmation when only warnings remain", () => {
    const a = base();
    const b = { ...base(), id: "T-2" };
    const gate = approvalGate(validateInvoice(b, [a, b]));
    expect(gate.canApprove).toBe(true);
    expect(gate.needsConfirmation).toBe(true);
  });

  it("flags duplicates with the same invoice number and GSTIN", () => {
    const a = base();
    const b = { ...base(), id: "T-2" };
    expect(validateInvoice(b, [a, b]).map((i) => i.code)).toContain("duplicate_candidate");
  });
});
