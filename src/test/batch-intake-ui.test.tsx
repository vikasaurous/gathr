import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDrop } from "@/components/gathr/file-drop";
import { PersistedBatchView } from "@/components/gathr/persisted-batch-view";
import { MAX_FILE_BYTES, MAX_FILES_PER_BATCH } from "@/lib/gathr/ingestion-types";
import { NewBatch } from "@/routes/app.new";

const mockToast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
);
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({
    children,
    to,
    ...props
  }: {
    children: ReactNode;
    to: string;
    [key: string]: unknown;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => mockNavigate,
}));

function makePdfFile(
  name: string,
  content = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n",
  type = "application/pdf",
) {
  return new File([content], name, { type });
}

function makeSizedPdfFile(name: string, sizeBytes: number) {
  const f = makePdfFile(name);
  Object.defineProperty(f, "size", { value: sizeBytes });
  return f;
}

describe("Phase 3 intake UI, validation, keyboard accessibility, and recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("handles empty state, valid multi-PDF selection, filename collision disambiguation, and file removal", async () => {
    render(<NewBatch />);

    expect(screen.getByText(/No PDFs selected yet/i)).toBeInTheDocument();
    const submitBtn = screen.getByRole("button", { name: /Add PDF files to continue/i });
    expect(submitBtn).toBeDisabled();

    // Never implies combined-PDF splitting or content extraction
    expect(screen.queryByText(/combined PDF/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Processing preferences/i)).not.toBeInTheDocument();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    fireEvent.change(fileInput, {
      target: {
        files: [
          makePdfFile("invoice.pdf"),
          makePdfFile("invoice.pdf"),
          makePdfFile("second-vendor.pdf"),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create batch (3 PDFs)" })).toBeEnabled();
    });

    const list = screen.getByRole("list", { name: "Selected PDF files" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(list).getByText("invoice.pdf")).toBeInTheDocument();
    expect(within(list).getByText("invoice (2).pdf")).toBeInTheDocument();
    expect(within(list).getByText("second-vendor.pdf")).toBeInTheDocument();

    // Remove the disambiguated file before upload
    fireEvent.click(screen.getByRole("button", { name: "Remove invoice (2).pdf" }));
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    });
    expect(screen.getByRole("button", { name: "Create batch (2 PDFs)" })).toBeEnabled();
  });

  it("explains rejections before upload for non-PDF, invalid signature, zero-byte, >50 MiB, and >25 files", async () => {
    render(<NewBatch />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(["plain"], "notes.txt", { type: "text/plain" }),
          makePdfFile("fake-content.pdf", "NOT-A-PDF"),
          makePdfFile("zero.pdf", ""),
          makeSizedPdfFile("too-big.pdf", MAX_FILE_BYTES + 1),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/missing %PDF- signature/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Only PDF \(\.pdf\) files are supported/i)).toBeInTheDocument();
    expect(screen.getByText(/File is empty/i)).toBeInTheDocument();
    expect(screen.getByText(/exceeds the 50 MiB limit/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fix rejected files to continue/i })).toBeDisabled();

    // Clean invalid files
    fireEvent.click(screen.getByRole("button", { name: "Remove invalid files" }));
    await waitFor(() => {
      expect(screen.getByText(/No PDFs selected yet/i)).toBeInTheDocument();
    });

    // Attempt 26 valid PDFs -> persistent over-limit alert and 26th file marked invalid
    const tooMany = Array.from({ length: MAX_FILES_PER_BATCH + 1 }, (_, i) =>
      makePdfFile(`bill-${i + 1}.pdf`),
    );
    fireEvent.change(fileInput, { target: { files: tooMany } });

    await waitFor(() => {
      expect(screen.getByText(/Batch limit exceeded: 26 files selected/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Exceeds the 25-file batch limit/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fix rejected files to continue/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Keep first 25" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create batch (25 PDFs)" })).toBeEnabled();
    });
  });

  it("supports keyboard navigation and blocks all actions when controls are disabled", () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    const files = [
      {
        id: "f1",
        file: makePdfFile("a.pdf"),
        sanitizedName: "a.pdf",
        displayName: "a.pdf",
      },
    ];

    const { rerender } = render(
      <FileDrop files={files} onAdd={onAdd} onRemove={onRemove} disabled={false} />,
    );

    const dropzone = screen.getByRole("button", { name: "Select PDF files" });
    expect(dropzone).toHaveAttribute("tabindex", "0");
    dropzone.focus();
    fireEvent.keyDown(dropzone, { key: "Enter" });
    fireEvent.keyDown(dropzone, { key: " " });
    expect(clickSpy).toHaveBeenCalledTimes(2);

    // Disabled state must block keyboard Enter/Space, click, drop, and remove
    clickSpy.mockClear();
    rerender(<FileDrop files={files} onAdd={onAdd} onRemove={onRemove} disabled={true} />);

    expect(dropzone).toHaveAttribute("tabindex", "-1");
    expect(dropzone).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(dropzone, { key: "Enter" });
    fireEvent.keyDown(dropzone, { key: " " });
    fireEvent.click(dropzone);
    fireEvent.drop(dropzone, { dataTransfer: { files: [makePdfFile("b.pdf")] } });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();

    const removeBtn = screen.getByRole("button", { name: "Remove a.pdf" });
    expect(removeBtn).toBeDisabled();
    fireEvent.click(removeBtn);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("prevents double-click duplicate requests and preserves files + idempotency key across network failure", async () => {
    let resolveFetch!: (res: Response) => void;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<NewBatch />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makePdfFile("bill.pdf")] } });

    const submitBtn = await screen.findByRole("button", { name: "Create batch (1 PDF)" });
    await waitFor(() => expect(submitBtn).toBeEnabled());

    // First click fails with network error: files preserved and alert displayed
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/Network error/i);
    });
    expect(screen.getByText("bill.pdf")).toBeInTheDocument();
    const firstKey = new Headers(fetchMock.mock.calls[0]![1]?.headers).get("Idempotency-Key");
    expect(firstKey).toBeTruthy();

    // Rapid double-click on retry sends exactly one request with the SAME Idempotency-Key
    const retryBtn = screen.getByRole("button", { name: "Create batch (1 PDF)" });
    const form = retryBtn.closest("form")!;
    fireEvent.click(retryBtn);
    fireEvent.click(retryBtn);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondKey = new Headers(fetchMock.mock.calls[1]![1]?.headers).get("Idempotency-Key");
    expect(secondKey).toBe(firstKey);
    expect(screen.getByRole("button", { name: /Creating batch/i })).toBeDisabled();

    resolveFetch(
      new Response(
        JSON.stringify({
          batch: {
            id: "11111111-1111-4111-1111-111111111111",
            name: "bill",
            status: "uploading",
            createdAt: "2026-11-26T00:00:00Z",
            updatedAt: "2026-11-26T00:00:00Z",
          },
          documents: [
            {
              id: "22222222-2222-4222-2222-222222222222",
              batchId: "11111111-1111-4111-1111-111111111111",
              originalFilename: "bill.pdf",
              mimeType: "application/pdf",
              fileSizeBytes: 31,
              status: "pending_upload",
              reviewStatus: null,
              pageCount: null,
              errorMessage: null,
              uploadedAt: null,
              createdAt: "2026-11-26T00:00:00Z",
            },
          ],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/app/batches/$id",
        params: { id: "11111111-1111-4111-1111-111111111111" },
      });
    });
  });

  it("recovers persisted batch and separate document items from server state on reload", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Temporary outage"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            batch: {
              id: "11111111-1111-4111-1111-111111111111",
              name: "Recovered November Batch",
              status: "uploading",
              createdAt: "2026-11-26T10:00:00Z",
              updatedAt: "2026-11-26T10:00:00Z",
            },
            documents: [
              {
                id: "22222222-2222-4222-2222-222222222222",
                batchId: "11111111-1111-4111-1111-111111111111",
                originalFilename: "alpha.pdf",
                mimeType: "application/pdf",
                fileSizeBytes: 2048,
                status: "pending_upload",
                reviewStatus: null,
                pageCount: null,
                errorMessage: null,
                uploadedAt: null,
                createdAt: "2026-11-26T10:00:00Z",
              },
              {
                id: "33333333-3333-4333-3333-333333333333",
                batchId: "11111111-1111-4111-1111-111111111111",
                originalFilename: "beta.pdf",
                mimeType: "application/pdf",
                fileSizeBytes: 4096,
                status: "pending_upload",
                reviewStatus: null,
                pageCount: null,
                errorMessage: null,
                uploadedAt: null,
                createdAt: "2026-11-26T10:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<PersistedBatchView batchId="11111111-1111-4111-1111-111111111111" />);

    await waitFor(() => {
      expect(screen.getByText("Could not load batch.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("Recovered November Batch")).toBeInTheDocument();
    });
    expect(screen.getByText("alpha.pdf")).toBeInTheDocument();
    expect(screen.getByText("beta.pdf")).toBeInTheDocument();
    expect(screen.getAllByText("Pending upload").length).toBeGreaterThanOrEqual(2);
  });
});
