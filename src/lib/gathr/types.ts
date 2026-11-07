export type FieldKey =
  | "supplier"
  | "gstin"
  | "invoiceNumber"
  | "invoiceDate"
  | "dueDate"
  | "taxableValue"
  | "cgst"
  | "sgst"
  | "igst"
  | "total"
  | "currency";

/** Where a field value came from. Never conflate extracted with corrected. */
export type FieldSource = "extracted" | "corrected" | "missing";

export interface InvoiceField {
  value: string;
  /** 0–1 extraction confidence. A hint for review, never proof of accuracy. */
  confidence: number | null;
  source: FieldSource;
  /** The value as originally extracted, preserved when a user corrects it. */
  originalValue?: string;
}

export type InvoiceStatus = "needs_review" | "verified" | "duplicate" | "skipped";

export interface Invoice {
  id: string;
  batchId: string;
  fileName: string;
  sourceFile: string;
  /** 1-based page numbers within the source file. Multi-page invoices list several. */
  pages: number[];
  fields: Record<FieldKey, InvoiceField>;
  status: InvoiceStatus;
  updatedAt: string;
  history: { at: string; action: string }[];
}

export type BatchStatus = "processing" | "completed" | "needs_review" | "failed";

export interface SourceFile {
  name: string;
  size: number;
  pageCount: number;
}

export interface Batch {
  id: string;
  name: string;
  createdAt: string;
  status: BatchStatus;
  files: SourceFile[];
  invoiceIds: string[];
  isDemo: boolean;
  error?: string;
}

export interface ProcessingPreferences {
  detectInvoices: boolean;
  detectDuplicates: boolean;
  extractGst: boolean;
  extractVendor: boolean;
  autoName: boolean;
  exportFormat: "csv" | "xlsx" | "zip" | "pdf";
}

export type ValidationCode =
  | "missing_invoice_number"
  | "invalid_gstin"
  | "missing_date"
  | "duplicate_candidate"
  | "tax_inconsistency"
  | "total_mismatch";

export interface ValidationIssue {
  code: ValidationCode;
  field?: FieldKey;
  severity: "error" | "warning";
  message: string;
}

export const FIELD_META: { key: FieldKey; label: string; kind: "text" | "date" | "money" | "code" }[] = [
  { key: "supplier", label: "Supplier name", kind: "text" },
  { key: "gstin", label: "GSTIN", kind: "code" },
  { key: "invoiceNumber", label: "Invoice number", kind: "code" },
  { key: "invoiceDate", label: "Invoice date", kind: "date" },
  { key: "dueDate", label: "Due date", kind: "date" },
  { key: "taxableValue", label: "Taxable value", kind: "money" },
  { key: "cgst", label: "CGST", kind: "money" },
  { key: "sgst", label: "SGST", kind: "money" },
  { key: "igst", label: "IGST", kind: "money" },
  { key: "total", label: "Total amount", kind: "money" },
  { key: "currency", label: "Currency", kind: "code" },
];
