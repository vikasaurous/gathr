/**
 * Processing engine boundary. The current implementation is a SIMULATION that
 * produces labelled demo invoices. Real PDF parsing, boundary detection, OCR and
 * extraction services should implement `ProcessingEngine` and replace `demoEngine`.
 */
import { generateInvoice } from "./demo-data";
import type { Batch, Invoice, ProcessingPreferences } from "./types";

export const PROCESSING_STAGES = [
  { key: "upload", label: "Uploading documents" },
  { key: "boundaries", label: "Detecting invoice boundaries" },
  { key: "extract", label: "Extracting financial information" },
  { key: "validate", label: "Validating records" },
  { key: "prepare", label: "Preparing review workspace" },
] as const;

export interface ProcessingInput {
  batchId: string;
  name: string;
  files: File[];
  prefs: ProcessingPreferences;
}

export interface ProcessingEngine {
  run(input: ProcessingInput, onStage: (index: number, progress: number) => void): Promise<{ batch: Batch; invoices: Invoice[] }>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const demoEngine: ProcessingEngine = {
  async run({ batchId, name, files }, onStage) {
    for (let s = 0; s < PROCESSING_STAGES.length; s++) {
      for (let p = 0; p <= 4; p++) {
        onStage(s, p / 4);
        await wait(180 + s * 40);
      }
    }
    const now = new Date().toISOString();
    const invoices: Invoice[] = [];
    let n = 0;
    const sourceFiles = files.map((f, fi) => {
      // Rough synthetic estimate: larger files contain more invoices.
      const count = Math.max(1, Math.min(8, Math.round(f.size / 400_000)));
      let page = 1;
      for (let k = 0; k < count; k++) {
        const flaws = [null, null, "low_conf", null, "bad_gstin", null, "total_mismatch"] as const;
        const inv = generateInvoice(`${batchId}-${String(n + 1).padStart(3, "0")}`, {
          batchId,
          sourceFile: f.name,
          startPage: page,
          seed: Date.now() % 100000 + n * 13 + fi,
          baseDate: now,
          flaw: flaws[n % flaws.length],
        });
        page += inv.pages.length;
        invoices.push(inv);
        n++;
      }
      return { name: f.name, size: f.size, pageCount: page - 1 };
    });
    return {
      batch: {
        id: batchId,
        name,
        createdAt: now,
        status: "needs_review",
        files: sourceFiles,
        invoiceIds: invoices.map((i) => i.id),
        isDemo: true,
      },
      invoices,
    };
  },
};
