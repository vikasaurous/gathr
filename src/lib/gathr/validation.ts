import { FIELD_META, type FieldKey, type Invoice, type ValidationIssue } from "./types";

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function isValidGstin(v: string) {
  return GSTIN_PATTERN.test(v.trim().toUpperCase());
}

const VALID_NUMBER_BODY = /^(?:\d+|\d{1,3}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;

export function parseAmount(v: string): number | null {
  let s = v.trim();
  if (!s) return null;

  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trimStart();
  }
  if (s.startsWith("₹")) {
    s = s.slice(1).trimStart();
  }
  if (!negative && s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trimStart();
  }

  if (!VALID_NUMBER_BODY.test(s)) return null;

  const n = Number(`${negative ? "-" : ""}${s.replace(/,/g, "")}`);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n;
}

/** Tolerance for rounding on totals, in currency units. */
export const AMOUNT_TOLERANCE = 1;

type ParsedMoney =
  | { status: "blank" }
  | { status: "valid"; value: number }
  | { status: "invalid"; issue: ValidationIssue };

function parseMonetaryField(raw: string, field: FieldKey): ParsedMoney {
  if (!raw.trim()) return { status: "blank" };
  const value = parseAmount(raw);
  if (value !== null) return { status: "valid", value };
  const label = FIELD_META.find((m) => m.key === field)?.label ?? field;
  return {
    status: "invalid",
    issue: {
      code: "invalid_amount",
      field,
      severity: "error",
      message: `${label} is not a valid amount.`,
    },
  };
}

function normalizedDiff(delta: number): number {
  const abs = Math.abs(delta);
  return abs < 1e15 ? Number(abs.toFixed(6)) : abs;
}

function normalizeCode(v: string): string {
  return v.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeText(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Flags problems. Never modifies values — financial data is only changed by people.
 */
export function validateInvoice(inv: Invoice, all: Invoice[] = []): ValidationIssue[] {
  const f = inv.fields;
  const issues: ValidationIssue[] = [];

  if (!f.invoiceNumber.value.trim())
    issues.push({
      code: "missing_invoice_number",
      field: "invoiceNumber",
      severity: "error",
      message: "Invoice number is missing.",
    });

  if (!f.gstin.value.trim() || !isValidGstin(f.gstin.value))
    issues.push({
      code: "invalid_gstin",
      field: "gstin",
      severity: "error",
      message: f.gstin.value.trim()
        ? "GSTIN does not match the 15-character format."
        : "GSTIN is missing.",
    });

  if (!f.invoiceDate.value.trim())
    issues.push({
      code: "missing_date",
      field: "invoiceDate",
      severity: "error",
      message: "Invoice date is missing.",
    });

  const taxableRes = parseMonetaryField(f.taxableValue.value, "taxableValue");
  const cgstRes = parseMonetaryField(f.cgst.value, "cgst");
  const sgstRes = parseMonetaryField(f.sgst.value, "sgst");
  const igstRes = parseMonetaryField(f.igst.value, "igst");
  const totalRes = parseMonetaryField(f.total.value, "total");

  for (const res of [taxableRes, cgstRes, sgstRes, igstRes, totalRes]) {
    if (res.status === "invalid") issues.push(res.issue);
  }

  const cgst = cgstRes.status === "valid" ? cgstRes.value : cgstRes.status === "blank" ? 0 : null;
  const sgst = sgstRes.status === "valid" ? sgstRes.value : sgstRes.status === "blank" ? 0 : null;
  const igst = igstRes.status === "valid" ? igstRes.value : igstRes.status === "blank" ? 0 : null;

  if (igst !== null && igst > 0 && ((cgst !== null && cgst > 0) || (sgst !== null && sgst > 0)))
    issues.push({
      code: "tax_inconsistency",
      field: "igst",
      severity: "warning",
      message: "IGST should not be charged together with CGST/SGST.",
    });
  else if (cgst !== null && sgst !== null && normalizedDiff(cgst - sgst) > AMOUNT_TOLERANCE)
    issues.push({
      code: "tax_inconsistency",
      field: "sgst",
      severity: "warning",
      message: "CGST and SGST are usually equal.",
    });

  if (
    taxableRes.status === "valid" &&
    totalRes.status === "valid" &&
    cgst !== null &&
    sgst !== null &&
    igst !== null
  ) {
    const expected = taxableRes.value + cgst + sgst + igst;
    if (normalizedDiff(expected - totalRes.value) > AMOUNT_TOLERANCE)
      issues.push({
        code: "total_mismatch",
        field: "total",
        severity: "error",
        message: `Total differs from taxable value + tax (${expected.toFixed(2)}).`,
      });
  }

  const dup = findDuplicate(inv, all);
  if (dup)
    issues.push({
      code: "duplicate_candidate",
      severity: "warning",
      message: `Possible duplicate of ${dup.fileName}.`,
    });

  return issues;
}

/** Approval gate: errors block approval; warnings need explicit confirmation. */
export function approvalGate(issues: ValidationIssue[]) {
  const blocking = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return {
    blocking,
    warnings,
    canApprove: blocking.length === 0,
    needsConfirmation: blocking.length === 0 && warnings.length > 0,
  };
}

export function warningFingerprint(warnings: ValidationIssue[]): string {
  return warnings
    .map((w) => `${w.code}:${w.field ?? ""}:${w.message}`)
    .sort()
    .join("|");
}

export interface ApprovalConfirmation {
  confirmedWarnings?: boolean | undefined;
  acknowledgedWarnings?: string | undefined;
}

export type ApprovalDecision =
  | { ok: true; gate: ReturnType<typeof approvalGate> }
  | {
      ok: false;
      reason: "blocking_errors" | "needs_confirmation" | "stale_warnings";
      gate: ReturnType<typeof approvalGate>;
      expectedWarningsFingerprint?: string | undefined;
    };

/** Authoritative approval guard used by both UI handlers and store actions. */
export function evaluateApproval(
  inv: Invoice,
  all: Invoice[],
  confirmation?: ApprovalConfirmation,
): ApprovalDecision {
  const gate = approvalGate(validateInvoice(inv, all));
  if (!gate.canApprove) {
    return { ok: false, reason: "blocking_errors", gate };
  }
  if (gate.needsConfirmation) {
    const expected = warningFingerprint(gate.warnings);
    if (!confirmation?.confirmedWarnings) {
      return {
        ok: false,
        reason: "needs_confirmation",
        gate,
        expectedWarningsFingerprint: expected,
      };
    }
    if (confirmation.acknowledgedWarnings !== expected) {
      return {
        ok: false,
        reason: "stale_warnings",
        gate,
        expectedWarningsFingerprint: expected,
      };
    }
  }
  return { ok: true, gate };
}

export function findDuplicate(inv: Invoice, all: Invoice[]): Invoice | undefined {
  const num = normalizeCode(inv.fields.invoiceNumber.value);
  if (!num) return undefined;

  const gstin = normalizeCode(inv.fields.gstin.value);
  const supplier = normalizeText(inv.fields.supplier.value);
  if (!gstin && !supplier) return undefined;

  return all.find((o) => {
    if (o.id === inv.id || o.status === "duplicate") return false;
    if (normalizeCode(o.fields.invoiceNumber.value) !== num) return false;
    const otherGstin = normalizeCode(o.fields.gstin.value);
    const otherSupplier = normalizeText(o.fields.supplier.value);
    const gstinMatch = Boolean(gstin && otherGstin && gstin === otherGstin);
    const supplierMatch = Boolean(supplier && otherSupplier && supplier === otherSupplier);
    return gstinMatch || supplierMatch;
  });
}
