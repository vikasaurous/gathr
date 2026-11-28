import { jsPDF } from "jspdf";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  formatReviewStatusLabel,
  stripControlChars,
  type DocumentReviewStatus,
  type DocumentUploadStatus,
} from "./ingestion-types";
import { FIELD_META, type Invoice } from "./types";

export const DEFAULT_FILENAME_TEMPLATE = "{vendor}_{invoice_number}_{date}.pdf";

/**
 * Normalizes a field value into a safe URL/filename-friendly token.
 * Preserves Unicode letters and combining marks across all scripts (Hindi, Tamil, Japanese, etc.).
 */
function slug(v?: string | null): string {
  if (!v) return "unknown";
  return (
    v
      .trim()
      .replace(/[^\p{L}\p{M}\p{N}-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/**
 * Builds a file name from a template string by replacing placeholders with slugified values.
 */
export function buildFileName(template: string, inv: Invoice): string {
  const t = template && template.trim() ? template.trim() : DEFAULT_FILENAME_TEMPLATE;
  return t
    .replaceAll("{vendor}", slug(inv.fields.supplier?.value))
    .replaceAll("{invoice_number}", slug(inv.fields.invoiceNumber?.value))
    .replaceAll("{date}", slug(inv.fields.invoiceDate?.value))
    .replaceAll("{gstin}", slug(inv.fields.gstin?.value));
}

/**
 * Removes dangerous path traversal sequences and characters illegal on Windows/POSIX filesystems.
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, "_")
    .replace(/[:*?"<>|]/g, "")
    .trim();
  return cleaned || "invoice.pdf";
}

/**
 * Generates a unique, sanitized file name for an invoice, preventing duplicate overwrites in archives.
 * Guarantees no double extensions (e.g. .pdf.pdf) and safe fallback for empty templates.
 */
export function buildSafeFileName(
  template: string,
  inv: Invoice,
  existingNames: Set<string> = new Set(),
): string {
  const rawTemplate = template && template.trim() ? template.trim() : DEFAULT_FILENAME_TEMPLATE;
  const normalizedTemplate = rawTemplate.replace(/\.pdf$/i, "");
  let built = buildFileName(normalizedTemplate, inv);
  built = built.replace(/\.pdf$/i, "");
  let fileName = sanitizeFileName(built);
  if (!fileName || fileName === "invoice.pdf") {
    fileName = `invoice_${inv.id || "record"}`;
  } else {
    fileName = fileName.replace(/\.pdf$/i, "");
  }
  fileName = `${fileName}.pdf`;

  if (!existingNames.has(fileName)) {
    existingNames.add(fileName);
    return fileName;
  }

  const baseName = fileName.replace(/\.pdf$/i, "");
  let counter = 1;
  let uniqueName = `${baseName} (${counter}).pdf`;
  while (existingNames.has(uniqueName)) {
    counter++;
    uniqueName = `${baseName} (${counter}).pdf`;
  }
  existingNames.add(uniqueName);
  return uniqueName;
}

/**
 * Tests whether a string represents a valid numeric financial literal
 * (e.g. "-100", "-12.50", "1500.00", "0", "-1,500.50").
 */
export function isLegitimateNumber(val: string): boolean {
  const trimmed = val.trim().replace(/,/g, "");
  if (!trimmed) return false;
  return /^-?\d+(?:\.\d+)?$/.test(trimmed);
}

/**
 * Protects untrusted text fields against CSV and Spreadsheet Formula Injection (CWE-1236 / OWASP).
 * If a cell value starts with `=`, `+`, `-`, `@`, `\t`, `\r`, or `\n`,
 * or leading whitespace followed by these characters, prepends a single quote `'`.
 *
 * Does not corrupt legitimate financial values:
 * Valid numeric values (such as "-100", "-12.50") remain uncorrupted numbers,
 * while malicious formula strings (such as "-1+1", "=cmd", "@SUM") are neutralized.
 */
export function sanitizeFormula(raw: string, isNumericField = false): string {
  if (!raw) return "";
  if (isNumericField || isLegitimateNumber(raw)) {
    if (isLegitimateNumber(raw)) {
      return raw;
    }
  }
  if (/^\s*[=+\-@\t\r\n]/.test(raw)) {
    return `'${raw}`;
  }
  return raw;
}

export const EXPORT_FORMATS = [
  { key: "csv", label: "CSV", description: "Spreadsheet-compatible data" },
  { key: "xlsx", label: "Excel workbook", description: "Structured spreadsheet (.xlsx)" },
  { key: "pdf", label: "PDF report", description: "Multi-page invoice report" },
  { key: "zip", label: "Combined ZIP", description: "Individual PDF summaries and CSV" },
] as const;

export type ExportFormatKey = (typeof EXPORT_FORMATS)[number]["key"];

/**
 * Filter invoices based on user export preferences.
 * Handles all 4 invoice statuses ('verified', 'needs_review', 'duplicate', 'skipped')
 * without contradiction or deadlocks.
 */
export function filterExportInvoices(
  invoices: Invoice[],
  options: {
    verifiedOnly: boolean;
    includeReview: boolean;
    excludeDup: boolean;
  },
): Invoice[] {
  const { verifiedOnly, includeReview, excludeDup } = options;
  return invoices.filter((i) => {
    if (i.status === "duplicate") {
      return !excludeDup;
    }
    if (i.status === "verified") {
      return true;
    }
    if (i.status === "needs_review") {
      return includeReview || !verifiedOnly;
    }
    return !verifiedOnly;
  });
}

/**
 * Normalizes text for PDF rendering without deleting non-Latin or complex Unicode characters.
 * Preserves Indian regional languages (e.g. Hindi, Tamil, Bengali), East Asian scripts (Japanese),
 * and currency symbols (such as ₹ / U+20B9) without lossy regex stripping.
 */
export function cleanPdfText(text?: string | null, fallback = ""): string {
  if (!text) return fallback;
  const normalized = text
    .normalize("NFC")
    .replace(/\u00A0/g, " ")
    .trim();
  return normalized || fallback;
}

/**
 * Escapes an individual CSV cell value according to RFC 4180 with type-aware formula protection.
 */
export function csvCell(v: string, isNumeric = false): string {
  const sanitized = sanitizeFormula(v, isNumeric);
  if (/[",\n\r]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

const NUMERIC_KEYS = new Set(["taxableValue", "cgst", "sgst", "igst", "total"]);

/**
 * Generates RFC 4180 compliant CSV string with UTF-8 BOM for universal spreadsheet compatibility.
 * Employs type-aware serialization so numeric amounts (e.g. -100) are never corrupted.
 */
export function invoicesToCsv(invoices: Invoice[]): string {
  const head = [...FIELD_META.map((m) => m.label), "Status", "Source file", "Pages", "Batch"];
  const rows = invoices.map((i) => [
    ...FIELD_META.map((m) =>
      csvCell(String(i.fields[m.key]?.value ?? ""), NUMERIC_KEYS.has(m.key)),
    ),
    csvCell(i.status, false),
    csvCell(i.sourceFile, false),
    csvCell(i.pages.join(" "), false),
    csvCell(i.batchId, false),
  ]);
  const csvBody = [
    head.map((h) => csvCell(h, false)).join(","),
    ...rows.map((r) => r.join(",")),
  ].join("\r\n");
  return `\uFEFF${csvBody}`;
}

/**
 * Parses financial amount string into a finite numeric value, or returns null if not numeric.
 */
export function parseFinancialNumber(v?: string | null): number | null {
  if (!v) return null;
  const cleaned = v.replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * Generates an Excel workbook (.xlsx) containing all selected invoice records and metadata.
 *
 * Exact data preservation (CWE-1236 & XLSX integrity):
 * - Does NOT use CSV formula sanitization (no prepended apostrophes).
 * - Untrusted text is stored as explicit string cells (`t: "s"`) with formula property `f` deleted.
 * - Legitimate financial values are stored as native numbers (`t: "n"`) with formatting `#,##0.00`.
 */
export function invoicesToXlsx(invoices: Invoice[]): Uint8Array {
  const head = [...FIELD_META.map((m) => m.label), "Status", "Source file", "Pages", "Batch"];
  const wb = XLSX.utils.book_new();
  const ws: XLSX.WorkSheet = {};
  const range: XLSX.Range = {
    s: { r: 0, c: 0 },
    e: { r: invoices.length, c: head.length - 1 },
  };

  // Header row
  head.forEach((h, colIdx) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: colIdx });
    ws[cellRef] = { t: "s", v: h };
  });

  // Data rows
  invoices.forEach((inv, rowIdx) => {
    const r = rowIdx + 1;
    let col = 0;

    FIELD_META.forEach((m) => {
      const cellRef = XLSX.utils.encode_cell({ r, c: col });
      const rawVal = inv.fields[m.key]?.value ?? "";
      if (NUMERIC_KEYS.has(m.key)) {
        const numVal = parseFinancialNumber(rawVal);
        if (numVal !== null) {
          ws[cellRef] = { t: "n", v: numVal, z: "#,##0.00" };
        } else {
          ws[cellRef] = { t: "s", v: String(rawVal) };
          delete ws[cellRef].f;
        }
      } else {
        // Untrusted text preserved exactly as string without prepending apostrophes
        ws[cellRef] = { t: "s", v: String(rawVal) };
        delete ws[cellRef].f;
      }
      col++;
    });

    // Metadata columns
    const metaValues = [
      formatStatusLabel(inv.status),
      inv.sourceFile,
      inv.pages.join(", "),
      inv.batchId,
    ];
    metaValues.forEach((val) => {
      const cellRef = XLSX.utils.encode_cell({ r, c: col });
      ws[cellRef] = { t: "s", v: String(val) };
      delete ws[cellRef].f;
      col++;
    });
  });

  ws["!ref"] = XLSX.utils.encode_range(range);

  // Compute readable column widths
  ws["!cols"] = head.map((h, colIndex) => {
    let maxLen = h.length;
    for (let r = 1; r <= invoices.length; r++) {
      const cellRef = XLSX.utils.encode_cell({ r, c: colIndex });
      const val = ws[cellRef]?.v;
      const len = val !== undefined && val !== null ? String(val).length : 0;
      if (len > maxLen) maxLen = len;
    }
    return { wch: Math.min(Math.max(maxLen + 3, 10), 45) };
  });

  XLSX.utils.book_append_sheet(wb, ws, "Invoices");
  const arrayBuffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(arrayBuffer);
}

/**
 * Formats a review/business status string using GATHR's canonical status labels
 * (e.g., 'needs_review' -> 'Needs review', null -> 'Unreviewed').
 */
export function formatStatusLabel(status: string | null | undefined): string {
  return formatReviewStatusLabel(status);
}

export interface PersistedExportDocument {
  id: string;
  batchId: string;
  batchName?: string | undefined;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  status: DocumentUploadStatus;
  reviewStatus: DocumentReviewStatus | null;
  uploadedAt: string | null;
  reviewUpdatedAt?: string | null | undefined;
  createdAt: string;
}

const UPLOAD_STATUS_LABELS: Record<DocumentUploadStatus, string> = {
  pending_upload: "Pending upload",
  uploading: "Uploading",
  uploaded: "Uploaded",
  failed: "Upload failed",
};

/**
 * Generates RFC 4180 CSV with UTF-8 BOM and formula neutralization for persisted
 * workspace documents using only actual captured metadata and canonical review labels.
 * Read-only: never mutates document or approval state.
 */
export function persistedDocumentsToCsv(documents: PersistedExportDocument[]): string {
  const head = [
    "Document ID",
    "Filename",
    "Batch",
    "Batch ID",
    "Upload status",
    "Review status",
    "MIME type",
    "File size (bytes)",
    "Uploaded at",
    "Review updated at",
    "Created at",
  ];
  const rows = documents.map((doc) => [
    csvCell(doc.id, false),
    csvCell(doc.originalFilename, false),
    csvCell(doc.batchName ?? doc.batchId, false),
    csvCell(doc.batchId, false),
    csvCell(UPLOAD_STATUS_LABELS[doc.status] ?? doc.status, false),
    csvCell(
      doc.status === "uploaded" ? formatReviewStatusLabel(doc.reviewStatus) : "Not uploaded",
      false,
    ),
    csvCell(doc.mimeType, false),
    csvCell(String(doc.fileSizeBytes), true),
    csvCell(doc.uploadedAt ?? "", false),
    csvCell(doc.reviewUpdatedAt ?? "", false),
    csvCell(doc.createdAt, false),
  ]);
  const csvBody = [
    head.map((h) => csvCell(h, false)).join(","),
    ...rows.map((r) => r.join(",")),
  ].join("\r\n");
  return `\uFEFF${csvBody}`;
}

const PERSISTED_EXPORT_HEADERS = [
  "Document ID",
  "Filename",
  "Batch",
  "Batch ID",
  "Upload status",
  "Review status",
  "MIME type",
  "File size (bytes)",
  "Uploaded at",
  "Review updated at",
  "Created at",
] as const;

export function buildPersistedExportBaseName(label: string, date: Date = new Date()): string {
  const slugLabel =
    label
      .replace(/\W+/g, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "") || "documents";
  const datePart = date.toISOString().slice(0, 10);
  return `gathr_${slugLabel}_${datePart}`;
}

/**
 * Produces a safe, traversal-free, unique `.pdf` archive entry filename for a persisted document.
 */
export function buildSafePersistedPdfName(
  originalFilename: string,
  documentId: string,
  existingNames: Set<string> = new Set(),
): string {
  // Strip control chars, path separators, traversal sequences, and illegal filesystem chars
  let cleaned = stripControlChars(originalFilename)
    .replace(/\.\.+/g, "_")
    .replace(/[/\\]/g, "_")
    .replace(/[:*?"<>|]/g, "")
    .trim()
    .replace(/^\.+/, "");

  cleaned = cleaned.replace(/\.pdf$/i, "").trim();
  if (!cleaned) {
    cleaned = `document_${documentId}`;
  }
  if (cleaned.length > 120) {
    cleaned = cleaned.slice(0, 120).trim();
  }

  const candidate = `${cleaned}.pdf`;
  if (!existingNames.has(candidate)) {
    existingNames.add(candidate);
    return candidate;
  }

  const baseName = cleaned;
  let counter = 1;
  let uniqueName = `${baseName} (${counter}).pdf`;
  while (existingNames.has(uniqueName)) {
    counter++;
    uniqueName = `${baseName} (${counter}).pdf`;
  }
  existingNames.add(uniqueName);
  return uniqueName;
}

/**
 * Generates an Excel workbook (.xlsx) for persisted workspace documents using only
 * persisted metadata and canonical review labels.
 * Untrusted text is stored as explicit string cells (`t: "s"`) with formula property `f` deleted.
 */
export function persistedDocumentsToXlsx(documents: PersistedExportDocument[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws: XLSX.WorkSheet = {};
  const range: XLSX.Range = {
    s: { r: 0, c: 0 },
    e: { r: documents.length, c: PERSISTED_EXPORT_HEADERS.length - 1 },
  };

  PERSISTED_EXPORT_HEADERS.forEach((h, colIdx) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: colIdx });
    ws[cellRef] = { t: "s", v: h };
  });

  documents.forEach((doc, rowIdx) => {
    const r = rowIdx + 1;
    const reviewLabel =
      doc.status === "uploaded" ? formatReviewStatusLabel(doc.reviewStatus) : "Not uploaded";
    const uploadLabel = UPLOAD_STATUS_LABELS[doc.status] ?? doc.status;

    const cells: Array<{ type: "s" | "n"; value: string | number; z?: string }> = [
      { type: "s", value: doc.id },
      { type: "s", value: doc.originalFilename },
      { type: "s", value: doc.batchName ?? doc.batchId },
      { type: "s", value: doc.batchId },
      { type: "s", value: uploadLabel },
      { type: "s", value: reviewLabel },
      { type: "s", value: doc.mimeType },
      { type: "n", value: doc.fileSizeBytes, z: "#,##0" },
      { type: "s", value: doc.uploadedAt ?? "" },
      { type: "s", value: doc.reviewUpdatedAt ?? "" },
      { type: "s", value: doc.createdAt },
    ];

    cells.forEach((cell, colIdx) => {
      const cellRef = XLSX.utils.encode_cell({ r, c: colIdx });
      if (cell.type === "n" && Number.isFinite(cell.value)) {
        ws[cellRef] = { t: "n", v: cell.value, z: cell.z };
      } else {
        ws[cellRef] = { t: "s", v: String(cell.value) };
        delete ws[cellRef].f;
      }
    });
  });

  ws["!ref"] = XLSX.utils.encode_range(range);
  ws["!cols"] = PERSISTED_EXPORT_HEADERS.map((h, colIndex) => {
    let maxLen = h.length;
    for (let r = 1; r <= documents.length; r++) {
      const cellRef = XLSX.utils.encode_cell({ r, c: colIndex });
      const val = ws[cellRef]?.v;
      const len = val !== undefined && val !== null ? String(val).length : 0;
      if (len > maxLen) maxLen = len;
    }
    return { wch: Math.min(Math.max(maxLen + 3, 10), 45) };
  });

  XLSX.utils.book_append_sheet(wb, ws, "Documents");
  const arrayBuffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(arrayBuffer);
}

/**
 * Generates a multi-page A4 PDF report summarizing persisted workspace documents.
 * Uses only persisted metadata and canonical review labels.
 */
export async function persistedDocumentsToPdfReport(
  documents: PersistedExportDocument[],
  options?: { title?: string | undefined; scopeLabel?: string | undefined },
): Promise<Uint8Array> {
  const doc = new jsPDF({ format: "a4", unit: "mm" });
  const title = cleanPdfText(options?.title, "GATHR Document Export Report");
  const scopeLabel = cleanPdfText(options?.scopeLabel, "Workspace documents");
  const generatedAt = new Date().toISOString();

  const pageWidth = 210;
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;
  let y = 18;
  let pageNum = 1;

  const drawHeader = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(28, 25, 23);
    doc.text(title, margin, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(87, 83, 78);
    doc.text(
      `Scope: ${scopeLabel}  |  Records: ${documents.length}  |  Generated: ${generatedAt}`,
      margin,
      y,
    );
    y += 4;
    doc.setDrawColor(214, 211, 209);
    doc.line(margin, y, pageWidth - margin, y);
    y += 6;
  };

  drawHeader();

  documents.forEach((item, index) => {
    if (y > 266) {
      doc.setFontSize(8);
      doc.setTextColor(120, 113, 108);
      doc.text(`Page ${pageNum}`, pageWidth - margin, 288, { align: "right" });
      doc.addPage("a4");
      pageNum++;
      y = 18;
      drawHeader();
    }

    const safeFilename = cleanPdfText(item.originalFilename, "document.pdf");
    const safeBatch = cleanPdfText(item.batchName ?? item.batchId, item.batchId);
    const uploadLabel = UPLOAD_STATUS_LABELS[item.status] ?? item.status;
    const reviewLabel =
      item.status === "uploaded" ? formatReviewStatusLabel(item.reviewStatus) : "Not uploaded";
    const sizeKb = `${Math.max(1, Math.round(item.fileSizeBytes / 1024))} KB`;
    const uploadedStr = item.uploadedAt
      ? item.uploadedAt.slice(0, 19).replace("T", " ") + " UTC"
      : "—";

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(28, 25, 23);
    const titleLine = doc.splitTextToSize(`${index + 1}. ${safeFilename}`, contentWidth);
    doc.text(titleLine.slice(0, 2), margin, y);
    y += Math.min(titleLine.length, 2) * 4.5;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(68, 64, 60);
    const metaLine = doc.splitTextToSize(
      `Batch: ${safeBatch}  |  Upload: ${uploadLabel}  |  Review: ${reviewLabel}  |  Size: ${sizeKb}  |  Uploaded: ${uploadedStr}`,
      contentWidth,
    );
    doc.text(metaLine.slice(0, 2), margin, y);
    y += Math.min(metaLine.length, 2) * 4;

    doc.setFontSize(7.5);
    doc.setTextColor(120, 113, 108);
    doc.text(`Document ID: ${item.id}  |  Batch ID: ${item.batchId}`, margin, y);
    y += 4;

    doc.setDrawColor(231, 229, 228);
    doc.line(margin, y, pageWidth - margin, y);
    y += 4;
  });

  doc.setFontSize(8);
  doc.setTextColor(120, 113, 108);
  doc.text(`Page ${pageNum}`, pageWidth - margin, 288, { align: "right" });

  const arrayBuffer = doc.output("arraybuffer");
  return new Uint8Array(arrayBuffer);
}

/**
 * Escapes characters for HTML injection protection in rendering template.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Generates semantic HTML markup for a single invoice page matching GATHR visual identity.
 * Employs standard browser font stack to support Indic complex-script shaping, East Asian kanji,
 * Latin accents, and the ₹ symbol.
 */
export function generateInvoiceHtml(inv: Invoice, pageNum: number, totalPages: number): string {
  const supplierName = cleanPdfText(inv.fields.supplier?.value, "Unknown Supplier");
  const currency = cleanPdfText(inv.fields.currency?.value, "INR");
  const confidenceText =
    inv.fields.supplier?.confidence !== null && inv.fields.supplier?.confidence !== undefined
      ? `${Math.round(inv.fields.supplier.confidence * 100)}% overall`
      : "Automated";

  const financialItems: [string, string][] = [
    ["Taxable Value", cleanPdfText(inv.fields.taxableValue?.value, "—")],
    ["Central GST (CGST)", cleanPdfText(inv.fields.cgst?.value, "—")],
    ["State GST (SGST)", cleanPdfText(inv.fields.sgst?.value, "—")],
    ["Integrated GST (IGST)", cleanPdfText(inv.fields.igst?.value, "—")],
  ];

  const financialRowsHtml = financialItems
    .map(
      ([desc, val]) => `
      <div style="display: flex; padding: 7px 12px; font-size: 11px; border-top: 1px solid #F0EFEB; color: #3C3E39;">
        <div style="flex: 1;">${escapeHtml(desc)}</div>
        <div style="width: 130px; text-align: right; font-weight: 500;">${escapeHtml(val)}</div>
        <div style="width: 60px; text-align: right; color: #8A8C85;">${escapeHtml(currency)}</div>
      </div>`,
    )
    .join("");

  return `
<div class="gathr-invoice-page" style="width: 794px; min-height: 1123px; padding: 48px; box-sizing: border-box; background: #FFFFFF; font-family: 'GathrFont', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #20211F; position: relative;">
  <style>
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 400;
      src: url('/fonts/noto-sans/noto-sans-latin-400.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD, U+20B9;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 700;
      src: url('/fonts/noto-sans/noto-sans-latin-700.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD, U+20B9;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 400;
      src: url('/fonts/noto-sans/noto-sans-devanagari-400.woff2') format('woff2');
      unicode-range: U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+20A8, U+20B9, U+25CC, U+A830-A839, U+A8E0-A8FF;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 700;
      src: url('/fonts/noto-sans/noto-sans-devanagari-700.woff2') format('woff2');
      unicode-range: U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+20A8, U+20B9, U+25CC, U+A830-A839, U+A8E0-A8FF;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 400;
      src: url('/fonts/noto-sans/noto-sans-tamil-400.woff2') format('woff2');
      unicode-range: U+0B82-0BFA, U+200C-200D, U+20B9, U+25CC;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 700;
      src: url('/fonts/noto-sans/noto-sans-tamil-700.woff2') format('woff2');
      unicode-range: U+0B82-0BFA, U+200C-200D, U+20B9, U+25CC;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 400;
      src: url('/fonts/noto-sans/noto-sans-bengali-400.woff2') format('woff2');
      unicode-range: U+0951-0952, U+0964-0965, U+0980-09FF, U+200C-200D, U+20B9, U+25CC;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 700;
      src: url('/fonts/noto-sans/noto-sans-bengali-700.woff2') format('woff2');
      unicode-range: U+0951-0952, U+0964-0965, U+0980-09FF, U+200C-200D, U+20B9, U+25CC;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 400;
      src: url('/fonts/noto-sans/noto-sans-jp-113-400-normal.woff2') format('woff2'),
           url('/fonts/noto-sans/noto-sans-jp-117-400-normal.woff2') format('woff2'),
           url('/fonts/noto-sans/noto-sans-jp-118-400-normal.woff2') format('woff2');
      unicode-range: U+3000-303F, U+3040-309F, U+30A0-30FF, U+4E00-9FAF, U+FF00-FFEF;
    }
    @font-face {
      font-family: 'GathrFont';
      font-style: normal;
      font-weight: 700;
      src: url('/fonts/noto-sans/noto-sans-jp-113-700-normal.woff2') format('woff2'),
           url('/fonts/noto-sans/noto-sans-jp-117-700-normal.woff2') format('woff2'),
           url('/fonts/noto-sans/noto-sans-jp-118-700-normal.woff2') format('woff2');
      unicode-range: U+3000-303F, U+3040-309F, U+30A0-30FF, U+4E00-9FAF, U+FF00-FFEF;
    }
  </style>
  <!-- Header & Brand -->
  <div style="display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 12px; border-bottom: 1px solid #E4E3DD;">
    <div>
      <div style="font-size: 26px; font-weight: 700; letter-spacing: -0.5px; line-height: 1;">gathr</div>
      <div style="font-size: 9.5px; font-weight: 600; color: #5C5E58; letter-spacing: 0.5px; margin-top: 5px;">INVOICE EXTRACTION RECORD</div>
    </div>
    <div style="text-align: right; font-size: 9.5px; color: #5C5E58; line-height: 1.5;">
      <div>BATCH: <span style="font-weight: 600; color: #20211F;">${escapeHtml(cleanPdfText(inv.batchId, "Default"))}</span></div>
      <div>RECORD: <span style="font-weight: 600; color: #20211F;">${escapeHtml(cleanPdfText(inv.id, "Record"))}</span></div>
      <div>STATUS: <span style="font-weight: 600; color: #20211F;">${escapeHtml(formatStatusLabel(inv.status).toUpperCase())}</span></div>
    </div>
  </div>

  <!-- Disclaimer Notice -->
  <div style="margin-top: 14px; background: #F6F5F0; border-radius: 4px; padding: 6px 12px; font-size: 10px; font-style: italic; color: #5C5E58;">
    Generated invoice summary — not original source document.
  </div>

  <!-- Supplier / Vendor Section -->
  <div style="margin-top: 22px;">
    <div style="font-size: 9.5px; font-weight: 600; letter-spacing: 0.5px; color: #8A8C85; text-transform: uppercase;">Supplier / Vendor</div>
    <div style="font-size: 19px; font-weight: 700; color: #20211F; margin-top: 4px; line-height: 1.3; word-break: break-word;">
      ${escapeHtml(supplierName)}
    </div>
  </div>

  <!-- Metadata Details Grid -->
  <div style="margin-top: 18px; background: #FCFBF9; border-radius: 6px; padding: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; border: 1px solid #F0EFEB;">
    <div>
      <div style="font-size: 9px; font-weight: 600; color: #8A8C85; text-transform: uppercase;">Invoice Number</div>
      <div style="font-size: 11.5px; font-weight: 700; color: #20211F; margin-top: 2px; word-break: break-all;">${escapeHtml(cleanPdfText(inv.fields.invoiceNumber?.value, "—"))}</div>
    </div>
    <div>
      <div style="font-size: 9px; font-weight: 600; color: #8A8C85; text-transform: uppercase;">GSTIN</div>
      <div style="font-size: 11.5px; font-weight: 700; color: #20211F; margin-top: 2px; word-break: break-all;">${escapeHtml(cleanPdfText(inv.fields.gstin?.value, "—"))}</div>
    </div>
    <div>
      <div style="font-size: 9px; font-weight: 600; color: #8A8C85; text-transform: uppercase;">Invoice Date</div>
      <div style="font-size: 11.5px; font-weight: 700; color: #20211F; margin-top: 2px;">${escapeHtml(cleanPdfText(inv.fields.invoiceDate?.value, "—"))}</div>
    </div>
    <div>
      <div style="font-size: 9px; font-weight: 600; color: #8A8C85; text-transform: uppercase;">Due Date</div>
      <div style="font-size: 11.5px; font-weight: 700; color: #20211F; margin-top: 2px;">${escapeHtml(cleanPdfText(inv.fields.dueDate?.value, "—"))}</div>
    </div>
    <div>
      <div style="font-size: 9px; font-weight: 600; color: #8A8C85; text-transform: uppercase;">Source Document</div>
      <div style="font-size: 11.5px; font-weight: 700; color: #20211F; margin-top: 2px; word-break: break-all;">${escapeHtml(cleanPdfText(inv.sourceFile, "Document"))}</div>
    </div>
    <div>
      <div style="font-size: 9px; font-weight: 600; color: #8A8C85; text-transform: uppercase;">Document Pages</div>
      <div style="font-size: 11.5px; font-weight: 700; color: #20211F; margin-top: 2px;">${escapeHtml(inv.pages.length ? `Page ${inv.pages.join(", ")}` : "—")}</div>
    </div>
    <div>
      <div style="font-size: 9px; font-weight: 600; color: #8A8C85; text-transform: uppercase;">Extraction Status</div>
      <div style="font-size: 11.5px; font-weight: 700; color: #20211F; margin-top: 2px;">${escapeHtml(formatStatusLabel(inv.status))}</div>
    </div>
    <div>
      <div style="font-size: 9px; font-weight: 600; color: #8A8C85; text-transform: uppercase;">Extraction Confidence</div>
      <div style="font-size: 11.5px; font-weight: 700; color: #20211F; margin-top: 2px;">${escapeHtml(confidenceText)}</div>
    </div>
  </div>

  <!-- Financial Breakdown Table -->
  <div style="margin-top: 22px;">
    <div style="font-size: 13px; font-weight: 700; color: #20211F; margin-bottom: 7px;">Financial Breakdown</div>
    <div style="border-radius: 4px; overflow: hidden; border: 1px solid #E4E3DD;">
      <div style="display: flex; background: #F0EFEB; padding: 7px 12px; font-size: 9.5px; font-weight: 700; color: #5C5E58; text-transform: uppercase;">
        <div style="flex: 1;">Field Description</div>
        <div style="width: 130px; text-align: right;">Amount</div>
        <div style="width: 60px; text-align: right;">Currency</div>
      </div>
      ${financialRowsHtml}
      <div style="display: flex; background: #F6F5F0; padding: 9px 12px; font-size: 11.5px; font-weight: 700; color: #20211F; border-top: 1px solid #E4E3DD;">
        <div style="flex: 1; text-transform: uppercase;">Total Amount</div>
        <div style="width: 130px; text-align: right;">${escapeHtml(cleanPdfText(inv.fields.total?.value, "—"))}</div>
        <div style="width: 60px; text-align: right;">${escapeHtml(currency)}</div>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div style="position: absolute; bottom: 36px; left: 48px; right: 48px; padding-top: 10px; border-top: 1px solid #E4E3DD; display: flex; justify-content: space-between; font-size: 9px; color: #8A8C85;">
    <div>GATHR Document Intelligence · Verified Export</div>
    <div>Page ${pageNum} of ${totalPages}</div>
  </div>
</div>`;
}

/**
 * Renders a single invoice summary page into a jsPDF document using vector text.
 * Wraps long metadata values dynamically without ellipsis truncation or overlapping.
 * Used as high-speed vector renderer and headless fallback.
 */
export function renderInvoicePdfPage(
  doc: jsPDF,
  inv: Invoice,
  pageNum: number,
  totalPages: number,
): void {
  const margin = 20;
  const pageWidth = 210;
  const contentWidth = pageWidth - margin * 2;

  // 1. Header & Brand
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(32, 33, 31); // #20211F
  doc.text("gathr", margin, 24);

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(92, 94, 88); // #5C5E58
  doc.text("INVOICE EXTRACTION RECORD", margin, 30);

  // Top right batch metadata
  doc.setFontSize(8);
  doc.text(`BATCH: ${cleanPdfText(inv.batchId, "Default")}`, pageWidth - margin, 22, {
    align: "right",
  });
  doc.text(`RECORD: ${cleanPdfText(inv.id, "Record")}`, pageWidth - margin, 26.5, {
    align: "right",
  });
  doc.text(`STATUS: ${formatStatusLabel(inv.status).toUpperCase()}`, pageWidth - margin, 31, {
    align: "right",
  });

  // Divider
  doc.setDrawColor(228, 227, 221); // #E4E3DD
  doc.setLineWidth(0.4);
  doc.line(margin, 35, pageWidth - margin, 35);

  // 2. Disclaimer Notice
  doc.setFillColor(246, 245, 240); // #F6F5F0
  doc.roundedRect(margin, 39, contentWidth, 8, 1, 1, "FD");
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(92, 94, 88);
  doc.text("Generated invoice summary — not original source document.", margin + 3.5, 44.5);

  // 3. Supplier / Vendor Section
  let y = 56;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(138, 140, 133); // #8A8C85
  doc.text("SUPPLIER / VENDOR", margin, y);

  y += 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(32, 33, 31);
  const supplierName = cleanPdfText(inv.fields.supplier?.value, "Unknown Supplier");
  const wrappedSupplier = doc.splitTextToSize(supplierName, contentWidth);
  doc.text(wrappedSupplier, margin, y);
  y += wrappedSupplier.length * 6 + 6;

  // 4. Metadata Details Grid (2 Columns with dynamic text wrapping, no truncation)
  const col1X = margin;
  const col2X = margin + contentWidth / 2;
  const maxColWidth = contentWidth / 2 - 8;

  const metadataItems: [string, string, string, string][] = [
    [
      "Invoice Number",
      cleanPdfText(inv.fields.invoiceNumber?.value, "—"),
      "GSTIN",
      cleanPdfText(inv.fields.gstin?.value, "—"),
    ],
    [
      "Invoice Date",
      cleanPdfText(inv.fields.invoiceDate?.value, "—"),
      "Due Date",
      cleanPdfText(inv.fields.dueDate?.value, "—"),
    ],
    [
      "Source Document",
      cleanPdfText(inv.sourceFile, "Document"),
      "Document Pages",
      inv.pages.length ? `Page ${inv.pages.join(", ")}` : "—",
    ],
    [
      "Extraction Status",
      formatStatusLabel(inv.status),
      "Extraction Confidence",
      inv.fields.supplier?.confidence !== null && inv.fields.supplier?.confidence !== undefined
        ? `${Math.round(inv.fields.supplier.confidence * 100)}% overall`
        : "Automated",
    ],
  ];

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  const computedRows = metadataItems.map(([l1, v1, l2, v2]) => {
    const lines1 = (doc.splitTextToSize(v1, maxColWidth) || []) as string[];
    const lines2 = (doc.splitTextToSize(v2, maxColWidth) || []) as string[];
    const maxLines = Math.max(lines1.length, lines2.length, 1);
    const height = Math.max(maxLines * 4.2 + 8, 12);
    return { l1, v1Lines: lines1, l2, v2Lines: lines2, height };
  });

  const totalGridHeight = computedRows.reduce((acc, r) => acc + r.height, 0) + 4;

  doc.setFillColor(252, 251, 249);
  doc.roundedRect(margin, y - 2, contentWidth, totalGridHeight, 1.5, 1.5, "FD");

  let rowY = y;
  computedRows.forEach(({ l1, v1Lines, l2, v2Lines, height }) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(138, 140, 133);
    doc.text(l1.toUpperCase(), col1X + 4, rowY + 3.5);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(32, 33, 31);
    doc.text(v1Lines, col1X + 4, rowY + 8);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(138, 140, 133);
    doc.text(l2.toUpperCase(), col2X + 4, rowY + 3.5);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(32, 33, 31);
    doc.text(v2Lines, col2X + 4, rowY + 8);

    rowY += height;
  });

  y = rowY + 8;

  // 5. Financial Breakdown Table
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(32, 33, 31);
  doc.text("Financial Breakdown", margin, y);

  y += 4;
  doc.setFillColor(240, 239, 235);
  doc.rect(margin, y, contentWidth, 7, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(92, 94, 88);
  doc.text("FIELD DESCRIPTION", margin + 4, y + 4.8);
  doc.text("AMOUNT", pageWidth - margin - 25, y + 4.8, { align: "right" });
  doc.text("CURRENCY", pageWidth - margin - 4, y + 4.8, { align: "right" });

  y += 7;

  const currency = cleanPdfText(inv.fields.currency?.value, "INR");

  const financialRows: [string, string][] = [
    ["Taxable Value", cleanPdfText(inv.fields.taxableValue?.value, "—")],
    ["Central GST (CGST)", cleanPdfText(inv.fields.cgst?.value, "—")],
    ["State GST (SGST)", cleanPdfText(inv.fields.sgst?.value, "—")],
    ["Integrated GST (IGST)", cleanPdfText(inv.fields.igst?.value, "—")],
  ];

  financialRows.forEach(([desc, val]) => {
    doc.setDrawColor(240, 239, 235);
    doc.setLineWidth(0.2);
    doc.line(margin, y, pageWidth - margin, y);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(60, 62, 57);
    doc.text(desc, margin + 4, y + 5.5);

    doc.setFont("helvetica", "normal");
    doc.text(val, pageWidth - margin - 25, y + 5.5, { align: "right" });
    doc.text(currency, pageWidth - margin - 4, y + 5.5, { align: "right" });

    y += 8;
  });

  // Total Amount Row
  doc.setFillColor(246, 245, 240);
  doc.rect(margin, y, contentWidth, 9, "F");
  doc.setDrawColor(228, 227, 221);
  doc.setLineWidth(0.4);
  doc.line(margin, y, pageWidth - margin, y);
  doc.line(margin, y + 9, pageWidth - margin, y + 9);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(32, 33, 31);
  doc.text("TOTAL AMOUNT", margin + 4, y + 6);
  doc.text(cleanPdfText(inv.fields.total?.value, "—"), pageWidth - margin - 25, y + 6, {
    align: "right",
  });
  doc.text(currency, pageWidth - margin - 4, y + 6, { align: "right" });

  // 6. Footer
  const footerY = 282;
  doc.setDrawColor(228, 227, 221);
  doc.setLineWidth(0.4);
  doc.line(margin, footerY - 5, pageWidth - margin, footerY - 5);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(138, 140, 133);
  doc.text("GATHR Document Intelligence · Verified Export", margin, footerY);
  doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - margin, footerY, { align: "right" });
}

/**
 * Attempts to render an invoice HTML page to an image data URL via browser DOM and html2canvas.
 * Returns null if not running in a browser environment or if rendering fails.
 */
async function renderHtmlToImage(
  inv: Invoice,
  pageNum: number,
  totalPages: number,
): Promise<string | null> {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    !document.body ||
    !window.HTMLCanvasElement ||
    (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent))
  ) {
    return null;
  }

  let container: HTMLDivElement | null = null;
  try {
    const html2canvasModule = await import("html2canvas");
    const html2canvas = html2canvasModule.default || html2canvasModule;

    container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-9999px";
    container.style.top = "-9999px";
    container.style.width = "794px";
    container.style.zIndex = "-100";
    container.innerHTML = generateInvoiceHtml(inv, pageNum, totalPages);
    document.body.appendChild(container);

    if (document.fonts) {
      if (document.fonts.load) {
        await Promise.all([
          document.fonts.load("400 14px 'GathrFont'"),
          document.fonts.load("700 14px 'GathrFont'"),
          document.fonts.load("400 14px 'GathrFont'", "टाटा मोटर्स"),
          document.fonts.load("400 14px 'GathrFont'", "தமிழ்"),
          document.fonts.load("400 14px 'GathrFont'", "বাংলা"),
          document.fonts.load("400 14px 'GathrFont'", "日本語"),
          document.fonts.load("400 14px 'GathrFont'", "₹"),
        ]).catch(() => {});
      }
      if (document.fonts.ready) {
        await document.fonts.ready;
      }
    }

    const pageElement = container.querySelector<HTMLElement>(".gathr-invoice-page") || container;
    const canvas = await html2canvas(pageElement, {
      scale: 2,
      logging: false,
      useCORS: true,
      backgroundColor: "#FFFFFF",
    });

    return canvas.toDataURL("image/jpeg", 0.95);
  } catch {
    return null;
  } finally {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }
}

/**
 * Generates a multi-page PDF report containing one page per selected invoice.
 * Renders high-resolution browser-shaped layout in supported browser environments,
 * and falls back to vector text rendering in headless/testing environments.
 */
export async function invoicesToPdfReport(invoices: Invoice[]): Promise<Uint8Array> {
  const doc = new jsPDF({ format: "a4", unit: "mm" });
  const total = invoices.length;

  for (let index = 0; index < total; index++) {
    const inv = invoices[index]!;
    if (index > 0) {
      doc.addPage("a4");
    }

    const imgData = await renderHtmlToImage(inv, index + 1, total);
    if (imgData) {
      doc.addImage(imgData, "JPEG", 0, 0, 210, 297, undefined, "FAST");
    } else {
      renderInvoicePdfPage(doc, inv, index + 1, total);
    }
  }

  const arrayBuffer = doc.output("arraybuffer");
  return new Uint8Array(arrayBuffer);
}

/**
 * Generates an individual PDF summary for a single invoice.
 */
export async function invoiceToSinglePdf(inv: Invoice): Promise<Uint8Array> {
  const doc = new jsPDF({ format: "a4", unit: "mm" });
  const imgData = await renderHtmlToImage(inv, 1, 1);
  if (imgData) {
    doc.addImage(imgData, "JPEG", 0, 0, 210, 297, undefined, "FAST");
  } else {
    renderInvoicePdfPage(doc, inv, 1, 1);
  }
  const arrayBuffer = doc.output("arraybuffer");
  return new Uint8Array(arrayBuffer);
}

/**
 * Generates a ZIP archive containing individual PDF summaries, invoices.csv, and manifest.json.
 * Follows required directory structure:
 * invoices.csv
 * manifest.json
 * invoices/
 *   ├── supplier_invoice_001.pdf
 *   └── ...
 */
export async function invoicesToZip(
  invoices: Invoice[],
  filenameTemplate: string = DEFAULT_FILENAME_TEMPLATE,
): Promise<Blob> {
  const zip = new JSZip();

  // 1. invoices.csv
  const csvContent = invoicesToCsv(invoices);
  zip.file("invoices.csv", csvContent);

  // 2. Individual PDF summaries inside invoices/ directory
  const existingNames = new Set<string>();
  const manifestFiles: string[] = [];

  for (const inv of invoices) {
    const fileName = buildSafeFileName(filenameTemplate, inv, existingNames);
    const archivePath = `invoices/${fileName}`;
    manifestFiles.push(archivePath);
    const pdfBytes = await invoiceToSinglePdf(inv);
    zip.file(archivePath, pdfBytes);
  }

  // 3. manifest.json
  const manifest = {
    exportTimestamp: new Date().toISOString(),
    invoiceCount: invoices.length,
    batchIds: Array.from(new Set(invoices.map((i) => i.batchId))),
    includedFiles: ["invoices.csv", "manifest.json", ...manifestFiles],
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  // 4. Generate Blob
  return await zip.generateAsync({
    type: "blob",
    mimeType: "application/zip",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/**
 * Downloads arbitrary Blob content with automatic object URL cleanup.
 */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Downloads CSV text content.
 */
export function downloadCsv(fileName: string, csvString: string): void {
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  downloadBlob(fileName, blob);
}

/**
 * Downloads Excel workbook binary content.
 */
export function downloadXlsx(fileName: string, xlsxBytes: Uint8Array): void {
  const blob = new Blob([xlsxBytes as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(fileName, blob);
}

/**
 * Downloads PDF report binary content.
 */
export function downloadPdf(fileName: string, pdfBytes: Uint8Array): void {
  const blob = new Blob([pdfBytes as unknown as BlobPart], { type: "application/pdf" });
  downloadBlob(fileName, blob);
}

/**
 * Legacy downloadText helper preserved for backward compatibility.
 */
export function downloadText(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  const blob = new Blob([text], { type });
  downloadBlob(name, blob);
}
