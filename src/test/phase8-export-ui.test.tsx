import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockToast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
);

vi.mock("sonner", () => ({
  toast: mockToast,
}));

import { PersistedExportDialog } from "@/components/gathr/persisted-export-dialog";

describe("Phase 8 — PersistedExportDialog UI", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => "blob:https://app.test/export");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("renders all 4 formats and sends workspace-scoped POST /api/exports", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("id,name\n1,a", {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="gathr_batch_2026-11-27.csv"',
          "X-Gathr-Export-Status": "complete",
          "X-Gathr-Export-Included-Count": "2",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PersistedExportDialog
        scope="batch"
        batchId="11111111-1111-4111-8111-111111111111"
        label="November Batch"
        totalCount={2}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    expect(screen.getByText("CSV")).toBeInTheDocument();
    expect(screen.getByText("Excel workbook")).toBeInTheDocument();
    expect(screen.getByText("PDF report")).toBeInTheDocument();
    expect(screen.getByText("Combined ZIP")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /download csv/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/exports",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(mockToast.success).toHaveBeenCalled();
    });
  });

  it("surfaces partial ZIP failure warning and lists failed filenames", async () => {
    const failures = [
      {
        documentId: "doc-2",
        filename: "missing_scan.pdf",
        code: "OBJECT_MISSING",
        reason: "Stored PDF object could not be found in storage.",
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="gathr_batch.zip"',
          "X-Gathr-Export-Status": "partial",
          "X-Gathr-Export-Included-Count": "1",
          "X-Gathr-Export-Failed-Count": "1",
          "X-Gathr-Export-Failures": encodeURIComponent(JSON.stringify(failures)),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PersistedExportDialog scope="workspace" label="Workspace documents" totalCount={2} />);

    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByText("Combined ZIP"));
    fireEvent.click(screen.getByRole("button", { name: /download combined zip/i }));

    await waitFor(() => {
      expect(mockToast.warning).toHaveBeenCalled();
      expect(screen.getByText(/missing_scan\.pdf/i)).toBeInTheDocument();
    });
  });

  it("displays safe error message when export fails with 422", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "No PDF documents could be packaged into the ZIP archive.",
          code: "EXPORT_NO_DOCUMENTS_AVAILABLE",
          failures: [
            {
              documentId: "doc-1",
              filename: "broken.pdf",
              code: "OBJECT_MISSING",
              reason: "Stored PDF object could not be found in storage.",
            },
          ],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PersistedExportDialog scope="workspace" label="Workspace documents" totalCount={1} />);

    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByText("Combined ZIP"));
    fireEvent.click(screen.getByRole("button", { name: /download combined zip/i }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        /No PDF documents could be packaged into the ZIP archive/i,
      );
    });
  });
});
