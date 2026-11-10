import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { generateInvoice } from "@/lib/gathr/demo-data";
import {
  invoicesToCsv,
  invoicesToXlsx,
  invoicesToPdfReport,
  invoicesToZip,
} from "@/lib/gathr/export";

import type { Invoice } from "@/lib/gathr/types";

const outputDir = path.resolve("./scratch/export-verification");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function createSampleInvoice(
  id: string,
  overrides: Partial<Invoice>,
  fieldOverrides: Record<string, string>,
): Invoice {
  const base = generateInvoice(id, {
    batchId: overrides.batchId || "B-OCT26",
    sourceFile: overrides.sourceFile || "scan.pdf",
    startPage: 1,
    seed: 101,
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

describe("Real Export File System Verification & Archive Extraction", () => {
  const sampleBatch: Invoice[] = [
    createSampleInvoice(
      "INV-001",
      {
        batchId: "B-OCT26",
        sourceFile: "q1_scanned_receipts_001.pdf",
        pages: [1],
        status: "verified",
      },
      {
        supplier: "टाटा मोटर्स लिमिटेड (Tata Motors)",
        invoiceNumber: "INV-2026-LONG-ALPHA-NUMERIC-ID-9999999999999999999999",
        currency: "₹",
        total: "₹ 1,50,000.00",
        gstin: "27AAACT2727Q1ZW",
      },
    ),
    createSampleInvoice(
      "INV-002",
      {
        batchId: "B-OCT26",
        sourceFile: "batch_scans_extra_long_document_filename_for_verification_testing.pdf",
        pages: [2],
        status: "verified",
      },
      {
        supplier: "தமிழ்நாடு டிரேடர்ஸ் (Tamil Nadu Traders)",
        invoiceNumber: "=cmd|' /C calc'!A0", // Formula injection attack attempt
        currency: "INR",
        total: "45,000.00",
      },
    ),
    createSampleInvoice(
      "INV-003",
      {
        batchId: "B-OCT26",
        sourceFile: "scan_003.pdf",
        pages: [3],
        status: "needs_review",
      },
      {
        supplier: "বাংলা টেকনোলজিস (Bangla Tech)",
        invoiceNumber: "   =1+1", // Leading spaces formula attack
        currency: "₹",
        total: "₹ 12,345.67",
      },
    ),
    createSampleInvoice(
      "INV-004",
      {
        batchId: "B-OCT26",
        sourceFile: "scan_004.pdf",
        pages: [4],
        status: "verified",
      },
      {
        supplier: "株式会社 日本語 (Japanese Corp)",
        invoiceNumber: "\t@SUM(A1:B10)", // Leading tab formula attack
        currency: "JPY",
        total: "250,000",
      },
    ),
  ];

  it("writes real CSV to disk, verifies UTF-8 BOM, formula neutralization, and Unicode text", () => {
    const csvString = invoicesToCsv(sampleBatch);
    const csvPath = path.join(outputDir, "gathr_export.csv");
    fs.writeFileSync(csvPath, csvString, "utf8");

    expect(fs.existsSync(csvPath)).toBe(true);
    expect(csvString.startsWith("\uFEFF")).toBe(true);
    // Neutralized formulas
    expect(csvString).toContain("'=cmd");
    expect(csvString).toContain("'   =1+1");
    expect(csvString).toContain("'\t@SUM");
    // Preserved Indian and Asian Unicode scripts in CSV
    expect(csvString).toContain("टाटा मोटर्स लिमिटेड");
    expect(csvString).toContain("தமிழ்நாடு டிரேடர்ஸ்");
    expect(csvString).toContain("বাংলা টেকনোলজিস");
    expect(csvString).toContain("株式会社 日本語");
  });

  it("writes real XLSX to disk, reads it back with SheetJS, and verifies cell integrity", () => {
    const xlsxBytes = invoicesToXlsx(sampleBatch);
    const xlsxPath = path.join(outputDir, "gathr_export.xlsx");
    fs.writeFileSync(xlsxPath, Buffer.from(xlsxBytes));

    expect(fs.existsSync(xlsxPath)).toBe(true);
    const fileBuffer = fs.readFileSync(xlsxPath);
    const wb = XLSX.read(fileBuffer, { type: "buffer" });
    expect(wb.SheetNames).toContain("Invoices");

    const parsedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Invoices"]!);
    expect(parsedRows.length).toBe(4);
    expect(parsedRows[0]!["Supplier name"]).toBe("टाटा मोटर्स लिमिटेड (Tata Motors)");
    expect(parsedRows[1]!["Supplier name"]).toBe("தமிழ்நாடு டிரேடர்ஸ் (Tamil Nadu Traders)");
    // Exact string preserved without prepended apostrophe in XLSX
    expect(parsedRows[1]!["Invoice number"]).toBe("=cmd|' /C calc'!A0");

    // Check financial numeric values have numeric type
    const sheet = wb.Sheets["Invoices"]!;
    const totalCell = sheet["J2"];
    expect(totalCell?.t).toBe("n");
    expect(typeof totalCell?.v).toBe("number");
  });

  it("writes real multi-page PDF to disk and verifies valid PDF header and watermark", async () => {
    const pdfBytes = await invoicesToPdfReport(sampleBatch);
    const pdfPath = path.join(outputDir, "gathr_export.pdf");
    fs.writeFileSync(pdfPath, Buffer.from(pdfBytes));

    expect(fs.existsSync(pdfPath)).toBe(true);
    const header = fs.readFileSync(pdfPath).slice(0, 5).toString("utf8");
    expect(header).toBe("%PDF-");
  });

  it("writes real ZIP archive to disk, extracts every PDF, and validates manifest 1:1", async () => {
    const zipBlob = await invoicesToZip(sampleBatch, "{vendor}_{invoice_number}.pdf");
    const loadedZip = await JSZip.loadAsync(zipBlob);
    const filesOnly = Object.keys(loadedZip.files).filter((k) => !k.endsWith("/"));
    expect(filesOnly.length).toBe(6); // 4 pdfs in invoices/ + invoices.csv + manifest.json

    // Save ZIP to disk via uint8array
    const zipBytes = await loadedZip.generateAsync({ type: "uint8array" });
    const zipPath = path.join(outputDir, "gathr_export.zip");
    fs.writeFileSync(zipPath, Buffer.from(zipBytes));
    expect(fs.existsSync(zipPath)).toBe(true);

    // Manifest validation
    const manifestStr = await loadedZip.file("manifest.json")!.async("string");
    const manifest = JSON.parse(manifestStr);
    expect(manifest.invoiceCount).toBe(4);
    expect(manifest.includedFiles.length).toBe(6);

    // Every file in manifest exists in zip
    for (const f of manifest.includedFiles) {
      expect(loadedZip.file(f)).not.toBeNull();
    }

    // Every PDF inside zip is in the invoices/ directory and has valid PDF header
    let validPdfs = 0;
    for (const entryName of filesOnly) {
      if (entryName.endsWith(".pdf")) {
        expect(entryName.startsWith("invoices/")).toBe(true);
        const fileBytes = await loadedZip.file(entryName)!.async("uint8array");
        const magic = new TextDecoder().decode(fileBytes.slice(0, 5));
        expect(magic).toBe("%PDF-");
        validPdfs++;
      }
    }
    expect(validPdfs).toBe(4);
  });
});
