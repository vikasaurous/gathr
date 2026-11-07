import { Copy, FileSearch, FileSpreadsheet, FolderArchive, Hash, Receipt, ScanLine, Split, Tag, UserCheck } from "lucide-react";

export const STEPS = [
  ["01", "Gather", "Bring combined PDFs and individual invoices into one workspace."],
  ["02", "Review", "Automatically detect documents and extract important financial details. Review uncertain information before approval."],
  ["03", "Organize", "Export verified invoices and structured records in formats ready for your workflow."],
] as const;

export const FEATURES = [
  [Split, "Automatic invoice separation", "Combined PDFs are split at each invoice boundary — multi-page invoices stay intact."],
  [FileSearch, "Vendor information extraction", "Supplier names and addresses, read from the page."],
  [Hash, "Invoice number and date", "Identifiers, invoice and due dates."],
  [Receipt, "GSTIN and tax details", "GSTIN format checks, CGST, SGST and IGST."],
  [Copy, "Duplicate detection", "Same number, same supplier — flagged before it reaches your books."],
  [Tag, "Automatic document naming", "{vendor}_{invoice_number}_{date}.pdf, or your own template."],
  [FileSpreadsheet, "CSV and Excel exports", "Structured records, ready for your accounting software."],
  [UserCheck, "Human verification", "Nothing is approved until a person approves it."],
  [FolderArchive, "Organized archives", "Every batch, every source page, kept together."],
  [ScanLine, "Bulk PDF processing", "Upload hundreds of pages at once."],
] as const;

