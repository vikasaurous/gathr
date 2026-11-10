import type { Invoice, ValidationIssue } from "./types";

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function isValidGstin(v: string) {
  return GSTIN_PATTERN.test(v.trim().toUpperCase());
}

export function parseAmount(v: string): number | null {
  if (!v || !v.trim()) return null;
  const n = Number(v.replace(/[,\s₹]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Tolerance for rounding on totals, in currency units. */
export const AMOUNT_TOLERANCE = 1;

/**
 * Flags problems. Never modifies values — financial data is only changed by people.
 */
export function validateInvoice(inv: Invoice, all: Invoice[] = []): ValidationIssue[] {
  const f = inv.fields;
  const issues: ValidationIssue[] = [];

  if (!f.invoiceNumber.value.trim())
    issues.push({ code: "missing_invoice_number", field: "invoiceNumber", severity: "error", message: "Invoice number is missing." });

  if (!f.gstin.value.trim() || !isValidGstin(f.gstin.value))
    issues.push({
      code: "invalid_gstin",
      field: "gstin",
      severity: "error",
      message: f.gstin.value.trim() ? "GSTIN does not match the 15-character format." : "GSTIN is missing.",
    });

  if (!f.invoiceDate.value.trim())
    issues.push({ code: "missing_date", field: "invoiceDate", severity: "error", message: "Invoice date is missing." });

  const taxable = parseAmount(f.taxableValue.value);
  const cgst = parseAmount(f.cgst.value) ?? 0;
  const sgst = parseAmount(f.sgst.value) ?? 0;
  const igst = parseAmount(f.igst.value) ?? 0;
  const total = parseAmount(f.total.value);

  if (igst > 0 && (cgst > 0 || sgst > 0))
    issues.push({ code: "tax_inconsistency", field: "igst", severity: "warning", message: "IGST should not be charged together with CGST/SGST." });
  else if (Math.abs(cgst - sgst) > AMOUNT_TOLERANCE)
    issues.push({ code: "tax_inconsistency", field: "sgst", severity: "warning", message: "CGST and SGST are usually equal." });

  if (taxable !== null && total !== null) {
    const expected = taxable + cgst + sgst + igst;
    if (Math.abs(expected - total) > AMOUNT_TOLERANCE)
      issues.push({
        code: "total_mismatch",
        field: "total",
        severity: "error",
        message: `Total differs from taxable value + tax (${expected.toFixed(2)}).`,
      });
  }

  const dup = findDuplicate(inv, all);
  if (dup)
    issues.push({ code: "duplicate_candidate", severity: "warning", message: `Possible duplicate of ${dup.fileName}.` });

  return issues;
}

/** Approval gate: errors block approval; warnings need explicit confirmation. */
export function approvalGate(issues: ValidationIssue[]) {
  const blocking = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { blocking, warnings, canApprove: blocking.length === 0, needsConfirmation: blocking.length === 0 && warnings.length > 0 };
}

export function findDuplicate(inv: Invoice, all: Invoice[]): Invoice | undefined {
  const num = inv.fields.invoiceNumber.value.trim().toUpperCase();
  const g = inv.fields.gstin.value.trim().toUpperCase();
  if (!num) return undefined;
  return all.find(
    (o) =>
      o.id !== inv.id &&
      o.status !== "duplicate" &&
      o.fields.invoiceNumber.value.trim().toUpperCase() === num &&
      (o.fields.gstin.value.trim().toUpperCase() === g ||
        o.fields.supplier.value.trim().toLowerCase() === inv.fields.supplier.value.trim().toLowerCase()),
  );
}
