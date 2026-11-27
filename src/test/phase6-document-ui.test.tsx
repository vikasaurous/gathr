import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  createFileRoute: () => () => ({}),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { PersistedBatchView } from "@/components/gathr/persisted-batch-view";
import type { PersistedBatch, PersistedDocument } from "@/lib/gathr/ingestion-types";
import { uploadOrchestrator } from "@/lib/gathr/upload-orchestrator";
import { Batches } from "@/routes/app.batches.index";

function makeBatch(
  status: PersistedBatch["status"] = "partial",
  finalizedAt: string | null = null,
): PersistedBatch {
  return {
    id: "11111111-1111-4111-1111-111111111111",
    name: "Phase 6 Batch",
    status,
    finalizedAt,
    createdAt: "2026-11-27T10:00:00Z",
    updatedAt: "2026-11-27T10:00:00Z",
  };
}

function makeDoc(
  id: string,
  filename: string,
  status: PersistedDocument["status"] = "uploaded",
  errorMessage: string | null = null,
): PersistedDocument {
  return {
    id,
    batchId: "11111111-1111-4111-1111-111111111111",
    originalFilename: filename,
    mimeType: "application/pdf",
    fileSizeBytes: 34,
    status,
    reviewStatus: null,
    pageCount: null,
    errorMessage,
    uploadedAt: status === "uploaded" ? "2026-11-27T10:01:00Z" : null,
    createdAt: "2026-11-27T10:00:00Z",
  };
}

function makePdfBytes(tag = "ok"): string {
  return `%PDF-1.7\n% ${tag}\n%%EOF\n`;
}

describe("Phase 6 — Document access UI (preview, unavailable recovery, search, single delete, focus)", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    uploadOrchestrator.reset();
    URL.createObjectURL = vi.fn(() => "blob:https://app.test/mock-pdf-object");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    uploadOrchestrator.reset();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reconstructs persisted state on reload, filters documents, and refreshes from server", async () => {
    const batchId = "11111111-1111-4111-1111-111111111111";
    const doc1 = makeDoc("22222222-2222-4222-2222-222222222222", "vendor-a.pdf", "uploaded");
    const doc2 = makeDoc(
      "33333333-3333-4333-8333-333333333333",
      "vendor-b.pdf",
      "failed",
      "Upload failed.",
    );

    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/batches/${batchId}`)) {
          fetchCount += 1;
          const docs =
            fetchCount === 1 ? [doc1, doc2] : [doc1, makeDoc(doc2.id, "vendor-b.pdf", "uploaded")];
          return new Response(
            JSON.stringify({
              batch: makeBatch(fetchCount === 1 ? "partial" : "uploaded"),
              documents: docs,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<PersistedBatchView batchId={batchId} />);

    expect(await screen.findByText("vendor-a.pdf")).toBeInTheDocument();
    expect(screen.getByText("vendor-b.pdf")).toBeInTheDocument();

    // Filter by search input
    const searchInput = screen.getByRole("textbox", { name: "Filter documents in batch" });
    fireEvent.change(searchInput, { target: { value: "vendor-a" } });
    expect(screen.getByText("vendor-a.pdf")).toBeInTheDocument();
    expect(screen.queryByText("vendor-b.pdf")).not.toBeInTheDocument();

    // Clear filter and refresh from server
    fireEvent.change(searchInput, { target: { value: "" } });
    const reloadBtn = screen.getByRole("button", { name: "Reload batch from server" });
    fireEvent.click(reloadBtn);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "View vendor-b.pdf" })).toBeInTheDocument();
    });
  });

  it("opens inline PDF preview modal, handles missing/unavailable B2 objects cleanly with Retry, and restores focus", async () => {
    const batchId = "11111111-1111-4111-1111-111111111111";
    const docId = "22222222-2222-4222-2222-222222222222";
    const doc = makeDoc(docId, "invoice-preview.pdf", "uploaded");

    let contentCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/batches/${batchId}`)) {
          return new Response(JSON.stringify({ batch: makeBatch("uploaded"), documents: [doc] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes(`/api/documents/${docId}/content`)) {
          contentCalls += 1;
          if (contentCalls === 1) {
            return new Response(
              JSON.stringify({
                error: "Stored PDF object could not be found.",
                code: "DOCUMENT_CONTENT_MISSING",
              }),
              { status: 404, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(makePdfBytes("recovered"), {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<PersistedBatchView batchId={batchId} />);

    const viewBtn = await screen.findByRole("button", { name: "View invoice-preview.pdf" });
    viewBtn.focus();
    fireEvent.click(viewBtn);

    // First attempt returns 404 -> recoverable error panel (never blank iframe)
    expect(await screen.findByText("PDF unavailable")).toBeInTheDocument();
    expect(screen.getByText("Stored PDF object could not be found.")).toBeInTheDocument();
    expect(screen.queryByTitle("PDF preview for invoice-preview.pdf")).not.toBeInTheDocument();

    // Retry preview -> loads valid PDF iframe
    fireEvent.click(screen.getByRole("button", { name: /Retry preview/i }));
    const iframe = await screen.findByTitle("PDF preview for invoice-preview.pdf");
    expect(iframe).toHaveAttribute("src", "blob:https://app.test/mock-pdf-object");

    // Close preview via Close button -> revokes Blob URL and restores focus to triggering button
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTitle("PDF preview for invoice-preview.pdf")).not.toBeInTheDocument();
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://app.test/mock-pdf-object");
    await waitFor(() => {
      expect(document.activeElement).toBe(viewBtn);
    });
  });

  it("shows recoverable inline error on Download failure and recovers cleanly on retry without saving JSON as a PDF", async () => {
    const batchId = "11111111-1111-4111-1111-111111111111";
    const docId = "22222222-2222-4222-2222-222222222222";
    const doc = makeDoc(docId, "broken-download.pdf", "uploaded");

    let downloadAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/batches/${batchId}`)) {
          return new Response(JSON.stringify({ batch: makeBatch("uploaded"), documents: [doc] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith(`/api/documents/${docId}/content?download=1`)) {
          downloadAttempts += 1;
          if (downloadAttempts === 1) {
            return new Response(
              JSON.stringify({
                error: "Could not retrieve PDF from object storage.",
                code: "STORAGE_UNAVAILABLE",
              }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(makePdfBytes("download-ok"), {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<PersistedBatchView batchId={batchId} />);

    const downloadBtn = await screen.findByRole("button", {
      name: "Download broken-download.pdf",
    });
    fireEvent.click(downloadBtn);

    expect(
      await screen.findByText("Could not retrieve PDF from object storage."),
    ).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByText("Could not retrieve PDF from object storage."),
    ).not.toBeInTheDocument();

    // Retry download -> succeeds with valid PDF Blob URL and triggers anchor click
    fireEvent.click(downloadBtn);
    await waitFor(() => {
      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("supports single-document deletion on unfinalized batches with focus preservation and hides single delete when finalized", async () => {
    const batchId = "11111111-1111-4111-1111-111111111111";
    const doc1Id = "22222222-2222-4222-2222-222222222222";
    const doc2Id = "33333333-3333-4333-8333-333333333333";
    const doc1 = makeDoc(doc1Id, "first.pdf", "uploaded");
    const doc2 = makeDoc(doc2Id, "second.pdf", "uploaded");

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/batches/${batchId}`) && (!init?.method || init.method === "GET")) {
          return new Response(
            JSON.stringify({ batch: makeBatch("uploaded"), documents: [doc1, doc2] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/documents/${doc1Id}`) && init?.method === "DELETE") {
          return new Response(
            JSON.stringify({
              deleted: true,
              documentId: doc1Id,
              batchId,
              batch: makeBatch("uploaded"),
              cleanupJobsQueued: 1,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<PersistedBatchView batchId={batchId} />);

    const deleteDoc1Btn = await screen.findByRole("button", { name: "Delete first.pdf" });
    fireEvent.click(deleteDoc1Btn);

    // Technical confirmation copy explicitly distinguishes removal from review decisions
    expect(
      await screen.findByText(/Removing a document does not mark it approved or rejected/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove document" }));

    await waitFor(() => {
      expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();
    });
    expect(screen.getByText("second.pdf")).toBeInTheDocument();

    // Focus moves to the remaining row rather than dropping to body
    const secondRow = screen.getByText("second.pdf").closest("li")!;
    expect(within(secondRow).getByRole("button", { name: "View second.pdf" })).toBe(
      document.activeElement,
    );

    // Re-render as finalized batch -> single-document Delete is hidden
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            batch: makeBatch("uploaded", "2026-11-27T11:00:00Z"),
            documents: [doc2],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    render(<PersistedBatchView batchId={batchId} />);
    await screen.findByText("second.pdf");
    expect(screen.queryByRole("button", { name: "Delete second.pdf" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View second.pdf" })).toBeInTheDocument();
  });

  it("handles session expiry (401), server refresh, and search/filtering in the Batches archive view", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/batches")) {
          call += 1;
          if (call === 1) {
            return new Response(JSON.stringify({ error: "Authentication required." }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              batches: [
                {
                  ...makeBatch("uploaded"),
                  documentCount: 2,
                  pendingCount: 0,
                  uploadedCount: 2,
                  failedCount: 0,
                  totalSizeBytes: 2048,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<Batches />);
    expect(
      await screen.findByText(/Your session has expired\. Please sign in again/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");

    fireEvent.click(screen.getByRole("button", { name: "Refresh batches" }));
    expect(await screen.findByText("Phase 6 Batch")).toBeInTheDocument();

    const batchSearch = screen.getByRole("textbox", { name: "Search batches" });
    fireEvent.change(batchSearch, { target: { value: "does-not-exist" } });
    expect(screen.getByText("No batches match.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Phase 6 Batch")).toBeInTheDocument();
  });

  it("Edge Cases: blocks non-PDF/empty 200 preview payloads, restores focus on delete cancel, and prevents stale-fetch races", async () => {
    const batchId = "11111111-1111-4111-1111-111111111111";
    const doc1 = makeDoc("22222222-2222-4222-2222-222222222222", "stale-one.pdf", "uploaded");
    const doc2 = makeDoc("33333333-3333-4333-8333-333333333333", "fresh-two.pdf", "uploaded");

    let resolveFirstFetch!: (res: Response) => void;
    let batchFetchNum = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/batches/${batchId}`)) {
          batchFetchNum += 1;
          if (batchFetchNum === 1) {
            return new Response(
              JSON.stringify({ batch: makeBatch("uploaded"), documents: [doc1] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (batchFetchNum === 2) {
            return await new Promise<Response>((resolve) => {
              resolveFirstFetch = resolve;
            });
          }
          return new Response(JSON.stringify({ batch: makeBatch("uploaded"), documents: [doc2] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes(`/api/documents/${doc2.id}/content`)) {
          // 200 OK masquerading as HTML proxy page -> must NOT render iframe
          return new Response("<html><body>Login wall</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<PersistedBatchView batchId={batchId} />);
    await screen.findByText("stale-one.pdf");

    // Rapid double Refresh: UI stays mounted (non-destructive refresh) and second call supersedes slow first call
    const refreshBtn = screen.getByRole("button", { name: "Reload batch from server" });
    fireEvent.click(refreshBtn); // batchFetchNum === 2 (pending)
    expect(screen.getByText("stale-one.pdf")).toBeInTheDocument();
    expect(refreshBtn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(refreshBtn); // batchFetchNum === 3 (resolves immediately with doc2)

    expect(await screen.findByText("fresh-two.pdf")).toBeInTheDocument();

    // Now resolve slow stale fetch #2 with doc1 -> must be ignored!
    resolveFirstFetch(
      new Response(JSON.stringify({ batch: makeBatch("uploaded"), documents: [doc1] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await waitFor(() => {
      expect(screen.getByText("fresh-two.pdf")).toBeInTheDocument();
      expect(screen.queryByText("stale-one.pdf")).not.toBeInTheDocument();
    });

    // Opening preview when server responds 200 text/html shows recoverable error (never iframe)
    fireEvent.click(screen.getByRole("button", { name: "View fresh-two.pdf" }));
    expect(await screen.findByText("PDF unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Server returned an unexpected response instead of a valid PDF."),
    ).toBeInTheDocument();
    expect(screen.queryByTitle("PDF preview for fresh-two.pdf")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // Cancelling single-doc delete restores focus to the triggering Delete button
    const delBtn = await screen.findByRole("button", { name: "Delete fresh-two.pdf" });
    delBtn.focus();
    fireEvent.click(delBtn);
    expect(await screen.findByText("Remove fresh-two.pdf?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByText("Remove fresh-two.pdf?")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(delBtn);
    });
  });
});
