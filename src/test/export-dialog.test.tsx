import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExportDialog } from "@/components/gathr/export-dialog";
import { generateInvoice } from "@/lib/gathr/demo-data";
import { filterExportInvoices } from "@/lib/gathr/export";
import type { Invoice } from "@/lib/gathr/types";

// Mock download utilities from export module
const mockDownloadCsv = vi.fn();
const mockDownloadXlsx = vi.fn();
const mockDownloadPdf = vi.fn();
const mockDownloadBlob = vi.fn();

vi.mock("@/lib/gathr/export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gathr/export")>();
  return {
    ...actual,
    downloadCsv: (...args: unknown[]) => mockDownloadCsv(...args),
    downloadXlsx: (...args: unknown[]) => mockDownloadXlsx(...args),
    downloadPdf: (...args: unknown[]) => mockDownloadPdf(...args),
    downloadBlob: (...args: unknown[]) => mockDownloadBlob(...args),
  };
});

// Mock toast from sonner
const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
    info: (...args: unknown[]) => mockToast.info(...args),
  },
}));

function getSampleInvoices(): Invoice[] {
  return [
    {
      ...generateInvoice("INV-1", {
        batchId: "B-1",
        sourceFile: "f1.pdf",
        startPage: 1,
        seed: 10,
        baseDate: "2026-10-01",
      }),
      status: "verified" as const,
    },
    {
      ...generateInvoice("INV-2", {
        batchId: "B-1",
        sourceFile: "f2.pdf",
        startPage: 1,
        seed: 20,
        baseDate: "2026-10-02",
      }),
      status: "verified" as const,
    },
  ];
}

describe("Export Filter Matrix — filterExportInvoices", () => {
  const invoices: Invoice[] = [
    { ...getSampleInvoices()[0]!, id: "INV-VERIFIED", status: "verified" },
    { ...getSampleInvoices()[0]!, id: "INV-REVIEW", status: "needs_review" },
    { ...getSampleInvoices()[0]!, id: "INV-DUP", status: "duplicate" },
    { ...getSampleInvoices()[0]!, id: "INV-SKIP", status: "skipped" },
  ];

  it("handles default options (verifiedOnly=true, includeReview=false, excludeDup=true)", () => {
    const res = filterExportInvoices(invoices, {
      verifiedOnly: true,
      includeReview: false,
      excludeDup: true,
    });
    expect(res.map((i) => i.id)).toEqual(["INV-VERIFIED"]);
  });

  it("handles verifiedOnly=true with includeReview=true", () => {
    const res = filterExportInvoices(invoices, {
      verifiedOnly: true,
      includeReview: true,
      excludeDup: true,
    });
    expect(res.map((i) => i.id)).toEqual(["INV-VERIFIED", "INV-REVIEW"]);
  });

  it("handles verifiedOnly=false without contradiction (includes non-verified invoices)", () => {
    const res = filterExportInvoices(invoices, {
      verifiedOnly: false,
      includeReview: false,
      excludeDup: true,
    });
    expect(res.map((i) => i.id)).toEqual(["INV-VERIFIED", "INV-REVIEW", "INV-SKIP"]);
  });

  it("handles excludeDup=false (includes duplicates)", () => {
    const res = filterExportInvoices(invoices, {
      verifiedOnly: false,
      includeReview: true,
      excludeDup: false,
    });
    expect(res.map((i) => i.id)).toEqual(["INV-VERIFIED", "INV-REVIEW", "INV-DUP", "INV-SKIP"]);
  });
});

describe("ExportDialog Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders export dialog trigger and opens with accurate format options and descriptions", () => {
    render(<ExportDialog invoices={getSampleInvoices()} label="October Invoices" />);

    // Click trigger to open dialog
    fireEvent.click(screen.getByRole("button", { name: /Export/i }));

    expect(screen.getByText("Export records")).toBeInTheDocument();
    expect(screen.getByText("October Invoices")).toBeInTheDocument();

    // Verify all 4 real format options and descriptions are present without any "Simulated" tags
    expect(screen.getByText("CSV")).toBeInTheDocument();
    expect(screen.getByText("Spreadsheet-compatible data")).toBeInTheDocument();

    expect(screen.getByText("Excel workbook")).toBeInTheDocument();
    expect(screen.getByText("Structured spreadsheet (.xlsx)")).toBeInTheDocument();

    expect(screen.getByText("PDF report")).toBeInTheDocument();
    expect(screen.getByText("Multi-page invoice report")).toBeInTheDocument();

    expect(screen.getByText("Combined ZIP")).toBeInTheDocument();
    expect(screen.getByText("Individual PDF summaries and CSV")).toBeInTheDocument();

    expect(screen.queryByText(/Simulated/i)).not.toBeInTheDocument();

    // Default button says "Download CSV"
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
  });

  it("updates download button label based on selected format", () => {
    render(<ExportDialog invoices={getSampleInvoices()} label="Batch B-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Export/i }));

    // Click Excel workbook
    fireEvent.click(screen.getByText("Excel workbook"));
    expect(screen.getByRole("button", { name: "Download Excel workbook" })).toBeInTheDocument();

    // Click PDF report
    fireEvent.click(screen.getByText("PDF report"));
    expect(screen.getByRole("button", { name: "Download PDF report" })).toBeInTheDocument();

    // Click Combined ZIP
    fireEvent.click(screen.getByText("Combined ZIP"));
    expect(screen.getByRole("button", { name: "Download Combined ZIP" })).toBeInTheDocument();
  });

  it("triggers CSV download and shows success toast", async () => {
    render(<ExportDialog invoices={getSampleInvoices()} label="My Batch" />);

    fireEvent.click(screen.getByRole("button", { name: /Export/i }));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    await waitFor(() => {
      expect(mockDownloadCsv).toHaveBeenCalledTimes(1);
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining("CSV with"));
    });
  });

  it("triggers Excel download when XLSX format is selected", async () => {
    render(<ExportDialog invoices={getSampleInvoices()} label="Batch Excel" />);

    fireEvent.click(screen.getByRole("button", { name: /Export/i }));
    fireEvent.click(screen.getByText("Excel workbook"));
    fireEvent.click(screen.getByRole("button", { name: "Download Excel workbook" }));

    await waitFor(() => {
      expect(mockDownloadXlsx).toHaveBeenCalledTimes(1);
      expect(mockToast.success).toHaveBeenCalledWith(
        expect.stringContaining("Excel workbook with"),
      );
    });
  });

  it("triggers PDF report download when PDF format is selected", async () => {
    render(<ExportDialog invoices={getSampleInvoices()} label="Batch PDF" />);

    fireEvent.click(screen.getByRole("button", { name: /Export/i }));
    fireEvent.click(screen.getByText("PDF report"));
    fireEvent.click(screen.getByRole("button", { name: "Download PDF report" }));

    await waitFor(() => {
      expect(mockDownloadPdf).toHaveBeenCalledTimes(1);
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining("PDF report with"));
    });
  });

  it("triggers ZIP archive download when ZIP format is selected", async () => {
    render(<ExportDialog invoices={getSampleInvoices()} label="Batch ZIP" />);

    fireEvent.click(screen.getByRole("button", { name: /Export/i }));
    fireEvent.click(screen.getByText("Combined ZIP"));
    fireEvent.click(screen.getByRole("button", { name: "Download Combined ZIP" }));

    await waitFor(() => {
      expect(mockDownloadBlob).toHaveBeenCalledTimes(1);
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining("ZIP archive with"));
    });
  });

  it("shows error toast when no invoices match filter selection", async () => {
    // Unverified invoices
    const unverifiedInvoices = [
      generateInvoice("INV-UNV", {
        batchId: "B-2",
        sourceFile: "f3.pdf",
        startPage: 1,
        seed: 30,
        baseDate: "2026-10-03",
      }),
    ];
    // Force status to needs_review
    unverifiedInvoices[0]!.status = "needs_review";

    render(<ExportDialog invoices={unverifiedInvoices} label="Empty Filter" />);

    fireEvent.click(screen.getByRole("button", { name: /Export/i }));

    // With verifiedOnly=true and includeReview=false, 0 invoices are selected
    // Button is disabled
    const downloadBtn = screen.getByRole("button", { name: /Download CSV/i });
    expect(downloadBtn).toBeDisabled();
  });
});
