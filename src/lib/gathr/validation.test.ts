import { describe, expect, it } from "vitest";
import { generateInvoice } from "./demo-data";
import {
  AMOUNT_TOLERANCE,
  approvalGate,
  evaluateApproval,
  findDuplicate,
  isValidGstin,
  parseAmount,
  validateInvoice,
  warningFingerprint,
} from "./validation";

const base = (id = "T-1") =>
  generateInvoice(id, {
    batchId: "T",
    sourceFile: "t.pdf",
    startPage: 1,
    seed: 5,
    baseDate: "2026-11-01T00:00:00Z",
  });

describe("invoice validation", () => {
  it("accepts a well-formed 15-character GSTIN and rejects a malformed one", () => {
    expect(isValidGstin("27AABCN4821K1Z6")).toBe(true);
    expect(isValidGstin("  27aabcn4821k1z6  ")).toBe(true);
    expect(isValidGstin("27AABCN4821K1Z")).toBe(false);
    expect(isValidGstin("")).toBe(false);
  });

  it("flags missing invoice number, missing/invalid GSTIN, and missing invoice date as errors", () => {
    const inv = base();
    inv.fields.invoiceNumber.value = "   ";
    inv.fields.gstin.value = "";
    inv.fields.invoiceDate.value = "";
    const issues = validateInvoice(inv);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_invoice_number",
          field: "invoiceNumber",
          severity: "error",
        }),
        expect.objectContaining({
          code: "invalid_gstin",
          field: "gstin",
          severity: "error",
          message: "GSTIN is missing.",
        }),
        expect.objectContaining({
          code: "missing_date",
          field: "invoiceDate",
          severity: "error",
        }),
      ]),
    );

    inv.fields.gstin.value = "INVALID";
    expect(validateInvoice(inv)).toContainEqual(
      expect.objectContaining({
        code: "invalid_gstin",
        field: "gstin",
        severity: "error",
        message: "GSTIN does not match the 15-character format.",
      }),
    );
  });

  it("flags IGST charged with CGST/SGST and mismatched CGST/SGST as warnings", () => {
    const inv = base();
    inv.fields.taxableValue.value = "1000.00";
    inv.fields.cgst.value = "90.00";
    inv.fields.sgst.value = "90.00";
    inv.fields.igst.value = "180.00";
    inv.fields.total.value = "1360.00";
    expect(validateInvoice(inv)).toContainEqual(
      expect.objectContaining({
        code: "tax_inconsistency",
        field: "igst",
        severity: "warning",
      }),
    );

    inv.fields.igst.value = "0.00";
    inv.fields.sgst.value = "95.00";
    inv.fields.total.value = "1185.00";
    expect(validateInvoice(inv)).toContainEqual(
      expect.objectContaining({
        code: "tax_inconsistency",
        field: "sgst",
        severity: "warning",
      }),
    );
  });

  it("flags a total that differs from taxable value plus tax beyond AMOUNT_TOLERANCE", () => {
    const inv = base();
    inv.fields.taxableValue.value = "100.10";
    inv.fields.cgst.value = "9.00";
    inv.fields.sgst.value = "9.00";
    inv.fields.igst.value = "0.00";
    // At exact tolerance boundary (1.00), including IEEE 754 float edge
    inv.fields.total.value = "119.10";
    expect(validateInvoice(inv).map((i) => i.code)).not.toContain("total_mismatch");

    inv.fields.total.value = "117.10";
    expect(validateInvoice(inv).map((i) => i.code)).not.toContain("total_mismatch");

    // Beyond tolerance (+1.01 and -1.01)
    inv.fields.total.value = (118.1 + AMOUNT_TOLERANCE + 0.01).toFixed(2);
    expect(validateInvoice(inv)).toContainEqual(
      expect.objectContaining({
        code: "total_mismatch",
        field: "total",
        severity: "error",
      }),
    );

    inv.fields.total.value = (118.1 - AMOUNT_TOLERANCE - 0.01).toFixed(2);
    expect(validateInvoice(inv).map((i) => i.code)).toContain("total_mismatch");
  });

  it("handles multiple simultaneous errors and warnings without mutating source invoices", () => {
    const original = base("T-1");
    original.fields.invoiceNumber.value = "";
    original.fields.gstin.value = "BAD";
    original.fields.invoiceDate.value = "";
    original.fields.cgst.value = "50.00";
    original.fields.sgst.value = "20.00";
    original.fields.total.value = "1.00";
    const snapshot = structuredClone(original);

    const issues = validateInvoice(original, [original]);
    const gate = approvalGate(issues);

    expect(gate.blocking.length).toBeGreaterThanOrEqual(4);
    expect(gate.warnings.length).toBeGreaterThanOrEqual(1);
    expect(gate.canApprove).toBe(false);
    expect(gate.needsConfirmation).toBe(false);
    expect(original).toEqual(snapshot);
  });

  it("blocks approval while a validation error remains and allows approval once resolved", () => {
    const inv = base();
    inv.fields.invoiceNumber.value = "";
    expect(approvalGate(validateInvoice(inv)).canApprove).toBe(false);
    expect(evaluateApproval(inv, [inv])).toMatchObject({
      ok: false,
      reason: "blocking_errors",
    });
    // Cannot bypass blocking error even if confirmedWarnings is supplied
    expect(
      evaluateApproval(inv, [inv], {
        confirmedWarnings: true,
        acknowledgedWarnings: "",
      }),
    ).toMatchObject({ ok: false, reason: "blocking_errors" });

    inv.fields.invoiceNumber.value = "INV-1";
    expect(approvalGate(validateInvoice(inv)).canApprove).toBe(true);
    expect(evaluateApproval(inv, [inv])).toMatchObject({ ok: true });
  });

  it("enforces warning confirmation and rejects stale warning fingerprints", () => {
    const a = base("T-1");
    const b = base("T-2");
    const issues = validateInvoice(b, [a, b]);
    const gate = approvalGate(issues);
    expect(gate.canApprove).toBe(true);
    expect(gate.needsConfirmation).toBe(true);

    // Without confirmation -> rejected
    expect(evaluateApproval(b, [a, b])).toMatchObject({
      ok: false,
      reason: "needs_confirmation",
    });

    // Confirmed without matching fingerprint -> rejected as stale
    expect(evaluateApproval(b, [a, b], { confirmedWarnings: true })).toMatchObject({
      ok: false,
      reason: "stale_warnings",
    });

    const fp1 = warningFingerprint(gate.warnings);
    expect(
      evaluateApproval(b, [a, b], {
        confirmedWarnings: true,
        acknowledgedWarnings: fp1,
      }),
    ).toMatchObject({ ok: true });

    // Warning set changes -> old fingerprint is rejected
    b.fields.igst.value = "0.00";
    b.fields.cgst.value = "100.00";
    b.fields.sgst.value = "0.00";
    b.fields.total.value = (Number(b.fields.taxableValue.value) + 100).toFixed(2);
    expect(
      evaluateApproval(b, [a, b], {
        confirmedWarnings: true,
        acknowledgedWarnings: fp1,
      }),
    ).toMatchObject({ ok: false, reason: "stale_warnings" });
  });
});

describe("duplicate detection matrix", () => {
  it("flags same invoice number with same non-empty GSTIN", () => {
    const a = base("T-1");
    const b = base("T-2");
    b.fields.supplier.value = "Different Supplier";
    expect(findDuplicate(b, [a, b])?.id).toBe("T-1");
    expect(validateInvoice(b, [a, b]).map((i) => i.code)).toContain("duplicate_candidate");
  });

  it("flags same invoice number with same non-empty supplier even when GSTINs differ", () => {
    const a = base("T-1");
    const b = base("T-2");
    b.fields.gstin.value = "27AABCN4821K1Z6";
    expect(findDuplicate(b, [a, b])?.id).toBe("T-1");
  });

  it("does not flag when both GSTINs are empty and suppliers differ", () => {
    const a = base("T-1");
    const b = base("T-2");
    a.fields.gstin.value = "";
    b.fields.gstin.value = "   ";
    b.fields.supplier.value = "Other Vendor LLP";
    expect(findDuplicate(b, [a, b])).toBeUndefined();
  });

  it("does not flag when both suppliers are empty and GSTINs differ", () => {
    const a = base("T-1");
    const b = base("T-2");
    a.fields.supplier.value = "";
    b.fields.supplier.value = "   ";
    b.fields.gstin.value = "27AABCN4821K1Z6";
    expect(findDuplicate(b, [a, b])).toBeUndefined();
  });

  it("does not flag when both GSTIN and supplier are empty", () => {
    const a = base("T-1");
    const b = base("T-2");
    a.fields.gstin.value = "";
    a.fields.supplier.value = "";
    b.fields.gstin.value = "";
    b.fields.supplier.value = "";
    expect(findDuplicate(b, [a, b])).toBeUndefined();
  });

  it("does not flag when invoice number matches but GSTIN and supplier both differ", () => {
    const a = base("T-1");
    const b = base("T-2");
    b.fields.gstin.value = "27AABCN4821K1Z6";
    b.fields.supplier.value = "Northfield Stationers Pvt Ltd";
    expect(findDuplicate(b, [a, b])).toBeUndefined();
  });

  it("normalizes whitespace and case consistently", () => {
    const a = base("T-1");
    a.fields.invoiceNumber.value = "INV/26  101";
    a.fields.supplier.value = "Northfield   Stationers Pvt Ltd";
    const b = base("T-2");
    b.fields.invoiceNumber.value = "  inv/26 101 ";
    b.fields.gstin.value = "27AABCN4821K1Z6";
    b.fields.supplier.value = "  northfield stationers pvt ltd ";
    expect(findDuplicate(b, [a, b])?.id).toBe("T-1");

    const c = base("T-3");
    c.fields.invoiceNumber.value = "inv/26 101";
    c.fields.supplier.value = "Someone Else";
    c.fields.gstin.value = `  ${a.fields.gstin.value.toLowerCase()} `;
    expect(findDuplicate(c, [a, c])?.id).toBe("T-1");
  });

  it("never matches an invoice against itself or records already marked duplicate", () => {
    const a = base("T-1");
    expect(findDuplicate(a, [a])).toBeUndefined();

    const dupMarked = { ...base("T-2"), status: "duplicate" as const };
    const c = base("T-3");
    expect(findDuplicate(c, [dupMarked, c])).toBeUndefined();
  });

  it("detects duplicates across batches in the workspace", () => {
    const a = { ...base("T-1"), batchId: "B-1001" };
    const b = { ...base("T-2"), batchId: "B-1002" };
    expect(findDuplicate(b, [a, b])?.id).toBe("T-1");
  });
});

describe("money parsing and validation safety", () => {
  it("parses valid integers, decimals, Indian grouping, zero, and negative amounts", () => {
    expect(parseAmount("1500")).toBe(1500);
    expect(parseAmount("1500.75")).toBe(1500.75);
    expect(parseAmount("1,23,456.78")).toBe(123456.78);
    expect(parseAmount("₹ 10,00,000.50")).toBe(1000000.5);
    expect(parseAmount("1,000,000.25")).toBe(1000000.25);
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("0.00")).toBe(0);
    expect(parseAmount("-0.00")).toBe(0);
    expect(parseAmount("-250.5")).toBe(-250.5);
    expect(parseAmount("-₹ 1,23,456.78")).toBe(-123456.78);
    expect(parseAmount("₹ -1,000.00")).toBe(-1000);
  });

  it("returns null for empty and malformed strings without coercing to zero", () => {
    for (const s of [
      "",
      "   ",
      "abc",
      "12abc",
      "100.50.25",
      "₹",
      "-",
      "-₹",
      ",",
      "1,23",
      "1,2,3",
      "1234,567",
      "100,",
      ",100",
      "100.",
      ".50",
      "1 000",
      "1e5",
      "0x10",
      "Infinity",
      "NaN",
      "--100",
      "₹₹100",
      "+100",
    ]) {
      expect(parseAmount(s)).toBeNull();
    }
  });

  it("handles blank optional tax fields consistently with existing behavior", () => {
    const inv = base();
    inv.fields.taxableValue.value = "1000.00";
    inv.fields.cgst.value = "";
    inv.fields.sgst.value = "";
    inv.fields.igst.value = "";
    inv.fields.total.value = "1000.00";
    expect(validateInvoice(inv)).toEqual([]);
  });

  it("supports valid negative credit-note amounts in total validation", () => {
    const inv = base();
    inv.fields.taxableValue.value = "-1000.00";
    inv.fields.cgst.value = "-90.00";
    inv.fields.sgst.value = "-90.00";
    inv.fields.igst.value = "0.00";
    inv.fields.total.value = "-1180.00";
    expect(validateInvoice(inv)).toEqual([]);
  });

  it("flags malformed non-empty monetary values as blocking errors without skipping validation or modifying values", () => {
    const inv = base();
    inv.fields.taxableValue.value = "1000.00";
    inv.fields.cgst.value = "0.00";
    inv.fields.sgst.value = "0.00";
    inv.fields.igst.value = "0.00";
    inv.fields.total.value = "abc";

    const issues = validateInvoice(inv);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_amount",
        field: "total",
        severity: "error",
      }),
    );
    expect(approvalGate(issues).canApprove).toBe(false);
    expect(inv.fields.total.value).toBe("abc");

    // Malformed optional tax field must not silently act as 0
    inv.fields.total.value = "1000.00";
    inv.fields.cgst.value = "not-a-number";
    const cgstIssues = validateInvoice(inv);
    expect(cgstIssues).toContainEqual(
      expect.objectContaining({
        code: "invalid_amount",
        field: "cgst",
        severity: "error",
      }),
    );
    expect(approvalGate(cgstIssues).canApprove).toBe(false);
    expect(inv.fields.cgst.value).toBe("not-a-number");
  });
});
