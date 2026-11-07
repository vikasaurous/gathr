/**
 * Synthetic demonstration data. All suppliers, GSTINs and amounts are fictional.
 */
import type { Batch, FieldKey, Invoice, InvoiceField } from "./types";

export const SUPPLIERS = [
  { name: "Northfield Stationers Pvt Ltd", gstin: "27AABCN4821K1Z6", state: "intra" },
  { name: "Kavya Logistics LLP", gstin: "29AAKFK3310M1ZQ", state: "inter" },
  { name: "Meridian Cloud Services", gstin: "07AAGCM9182P1Z3", state: "inter" },
  { name: "Tarang Print House", gstin: "27AAEFT6620H1ZB", state: "intra" },
  { name: "Halden & Roy Consulting", gstin: "27AAJFH1194C1Z8", state: "intra" },
  { name: "Sona Office Interiors", gstin: "24AAXCS5521R1ZK", state: "inter" },
  { name: "Brightline Telecom Ltd", gstin: "27AABCB7730E1Z1", state: "intra" },
  { name: "Orchid Facility Mgmt", gstin: "33AAFCO8846L1ZT", state: "inter" },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function field(value: string, confidence: number | null): InvoiceField {
  return value ? { value, confidence, source: "extracted" } : { value: "", confidence: null, source: "missing" };
}

export interface GenOptions {
  batchId: string;
  sourceFile: string;
  startPage: number;
  seed: number;
  baseDate: string;
  flaw?: "missing_number" | "bad_gstin" | "total_mismatch" | "missing_date" | "low_conf" | null;
  duplicateOf?: Invoice;
}

export function generateInvoice(id: string, o: GenOptions): Invoice {
  const r = rng(o.seed);
  const sup = o.duplicateOf
    ? SUPPLIERS.find((s) => s.name === o.duplicateOf!.fields.supplier.value) ?? SUPPLIERS[0]
    : SUPPLIERS[Math.floor(r() * SUPPLIERS.length)];
  const taxable = o.duplicateOf ? Number(o.duplicateOf.fields.taxableValue.value) : Math.round((2000 + r() * 180000) * 100) / 100;
  const rate = [0.05, 0.12, 0.18, 0.18, 0.28][Math.floor(r() * 5)];
  const tax = Math.round(taxable * rate * 100) / 100;
  const intra = sup.state === "intra";
  const half = Math.round((tax / 2) * 100) / 100;
  let total = Math.round((taxable + (intra ? half * 2 : tax)) * 100) / 100;
  if (o.flaw === "total_mismatch") total = Math.round((total + 1180) * 100) / 100;
  const d = new Date(o.baseDate);
  d.setUTCDate(d.getUTCDate() - Math.floor(r() * 25));
  const date = d.toISOString().slice(0, 10);
  const due = new Date(d);
  due.setUTCDate(due.getUTCDate() + 30);
  const num = o.duplicateOf
    ? o.duplicateOf.fields.invoiceNumber.value
    : `${sup.name.slice(0, 3).toUpperCase()}/${d.getUTCFullYear().toString().slice(2)}-${String(100 + Math.floor(r() * 900))}`;
  const c = () => Math.round((0.86 + r() * 0.14) * 100) / 100;
  const low = o.flaw === "low_conf";
  const pageCount = r() > 0.7 ? 2 : 1;
  const fields: Record<FieldKey, InvoiceField> = {
    supplier: field(sup.name, c()),
    gstin: field(o.flaw === "bad_gstin" ? sup.gstin.slice(0, 13) + "0" : sup.gstin, o.flaw === "bad_gstin" ? 0.58 : c()),
    invoiceNumber: field(o.flaw === "missing_number" ? "" : num, c()),
    invoiceDate: field(o.flaw === "missing_date" ? "" : date, low ? 0.62 : c()),
    dueDate: field(due.toISOString().slice(0, 10), low ? 0.55 : c()),
    taxableValue: field(taxable.toFixed(2), c()),
    cgst: field(intra ? half.toFixed(2) : "0.00", c()),
    sgst: field(intra ? half.toFixed(2) : "0.00", c()),
    igst: field(intra ? "0.00" : tax.toFixed(2), c()),
    total: field(total.toFixed(2), low ? 0.64 : c()),
    currency: field("INR", 0.99),
  };
  return {
    id,
    batchId: o.batchId,
    fileName: `${sup.name.split(" ")[0]}_${num.replace(/\//g, "-") || "unnumbered"}.pdf`,
    sourceFile: o.sourceFile,
    pages: Array.from({ length: pageCount }, (_, i) => o.startPage + i),
    fields,
    status: "needs_review",
    updatedAt: o.baseDate,
    history: [{ at: o.baseDate, action: "Extracted (demo engine)" }],
  };
}

type Flaw = GenOptions["flaw"];

function seedBatch(
  id: string,
  name: string,
  createdAt: string,
  files: { name: string; size: number }[],
  perFile: number[],
  flaws: Record<number, Flaw>,
  verifyRatio: number,
  dupIdx?: number,
): { batch: Batch; invoices: Invoice[] } {
  const invoices: Invoice[] = [];
  let n = 0;
  const sourceFiles = files.map((f, fi) => {
    let page = 1;
    for (let k = 0; k < perFile[fi]; k++) {
      const inv = generateInvoice(`${id}-${String(n + 1).padStart(3, "0")}`, {
        batchId: id,
        sourceFile: f.name,
        startPage: page,
        seed: id.length * 97 + n * 31 + fi * 7 + createdAt.charCodeAt(9),
        baseDate: createdAt,
        flaw: flaws[n] ?? null,
        duplicateOf: dupIdx === n && invoices[0] ? invoices[0] : undefined,
      });
      page += inv.pages.length;
      invoices.push(inv);
      n++;
    }
    return { name: f.name, size: f.size, pageCount: page - 1 };
  });
  const verifyCount = Math.floor(invoices.length * verifyRatio);
  invoices.forEach((inv, i) => {
    if (i < verifyCount && !flaws[i] && i !== dupIdx) {
      inv.status = "verified";
      inv.history.push({ at: createdAt, action: "Approved" });
    }
  });
  const needs = invoices.some((i) => i.status === "needs_review");
  return {
    batch: {
      id,
      name,
      createdAt,
      status: needs ? "needs_review" : "completed",
      files: sourceFiles,
      invoiceIds: invoices.map((i) => i.id),
      isDemo: true,
    },
    invoices,
  };
}

export function buildDemoState() {
  const a = seedBatch(
    "B-1042",
    "October vendor bills",
    "2026-11-05T10:24:00Z",
    [{ name: "october_vendor_bills_combined.pdf", size: 8_420_112 }],
    [14],
    { 3: "bad_gstin", 7: "total_mismatch", 10: "low_conf" },
    0.55,
    12,
  );
  const b = seedBatch(
    "B-1041",
    "Halden & Roy — Q3 retainers",
    "2026-11-02T15:02:00Z",
    [
      { name: "HR_retainer_jul.pdf", size: 312_004 },
      { name: "HR_retainer_aug.pdf", size: 298_744 },
      { name: "HR_retainer_sep.pdf", size: 305_120 },
    ],
    [1, 1, 1],
    {},
    1,
  );
  const c = seedBatch(
    "B-1040",
    "Travel & logistics, week 43",
    "2026-10-28T09:40:00Z",
    [{ name: "logistics_wk43_scan.pdf", size: 5_120_400 }],
    [9],
    { 2: "missing_number", 5: "missing_date" },
    0.6,
  );
  const d = seedBatch(
    "B-1039",
    "Office fit-out invoices",
    "2026-10-19T12:10:00Z",
    [{ name: "fitout_invoices.pdf", size: 3_880_220 }],
    [6],
    {},
    1,
  );
  const failed: Batch = {
    id: "B-1038",
    name: "Scanned receipts (low resolution)",
    createdAt: "2026-10-15T08:05:00Z",
    status: "failed",
    files: [{ name: "receipts_phone_scan.pdf", size: 22_400_000, pageCount: 0 }],
    invoiceIds: [],
    isDemo: true,
    error: "The file could not be read. Try a higher-resolution scan under 20 MB.",
  };
  return {
    batches: [a.batch, b.batch, c.batch, d.batch, failed],
    invoices: [...a.invoices, ...b.invoices, ...c.invoices, ...d.invoices],
  };
}
