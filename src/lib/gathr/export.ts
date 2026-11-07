import { FIELD_META, type Invoice } from "./types";

export const DEFAULT_FILENAME_TEMPLATE = "{vendor}_{invoice_number}_{date}.pdf";

function slug(v: string) {
  return v.trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function buildFileName(template: string, inv: Invoice) {
  return template
    .replaceAll("{vendor}", slug(inv.fields.supplier.value))
    .replaceAll("{invoice_number}", slug(inv.fields.invoiceNumber.value))
    .replaceAll("{date}", slug(inv.fields.invoiceDate.value))
    .replaceAll("{gstin}", slug(inv.fields.gstin.value));
}

function csvCell(v: string) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function invoicesToCsv(invoices: Invoice[]) {
  const head = [...FIELD_META.map((m) => m.label), "Status", "Source file", "Pages", "Batch"];
  const rows = invoices.map((i) => [
    ...FIELD_META.map((m) => i.fields[m.key].value),
    i.status,
    i.sourceFile,
    i.pages.join(" "),
    i.batchId,
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

export function downloadText(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
