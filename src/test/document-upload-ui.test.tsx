import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistedBatchView } from "@/components/gathr/persisted-batch-view";
import type {
  PersistedBatch,
  PersistedDocument,
  UploadDocumentResponse,
} from "@/lib/gathr/ingestion-types";
import {
  createUploadOrchestrator,
  MAX_CONCURRENT_UPLOADS,
  uploadOrchestrator,
  type UploadTransport,
} from "@/lib/gathr/upload-orchestrator";

vi.mock("@tanstack/react-router", () => ({
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
}));

function makePdfFile(name: string, content = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n") {
  return new File([content], name, { type: "application/pdf" });
}

function makeDoc(
  id: string,
  filename: string,
  sizeBytes: number,
  status: PersistedDocument["status"] = "pending_upload",
  errorMessage: string | null = null,
): PersistedDocument {
  return {
    id,
    batchId: "11111111-1111-4111-1111-111111111111",
    originalFilename: filename,
    mimeType: "application/pdf",
    fileSizeBytes: sizeBytes,
    status,
    reviewStatus: null,
    pageCount: null,
    errorMessage,
    uploadedAt: status === "uploaded" ? "2026-11-26T10:01:00Z" : null,
    createdAt: "2026-11-26T10:00:00Z",
  };
}

function makeBatch(status: PersistedBatch["status"] = "uploading"): PersistedBatch {
  return {
    id: "11111111-1111-4111-1111-111111111111",
    name: "Phase 4 UI Batch",
    status,
    createdAt: "2026-11-26T10:00:00Z",
    updatedAt: "2026-11-26T10:00:00Z",
  };
}

describe("Client upload orchestrator concurrency, progress, cancel, and retry", () => {
  it("strictly enforces maximum concurrency of 2 across 4 documents and updates progress", async () => {
    expect(MAX_CONCURRENT_UPLOADS).toBe(2);

    const active = new Set<string>();
    let peakActive = 0;
    const deferreds = new Map<
      string,
      {
        resolve: (res: UploadDocumentResponse) => void;
        reject: (err: Error) => void;
        onProgress: (loaded: number, total: number) => void;
      }
    >();

    const transport: UploadTransport = {
      upload({ documentId, onProgress }) {
        active.add(documentId);
        peakActive = Math.max(peakActive, active.size);
        let resolveFn!: (res: UploadDocumentResponse) => void;
        let rejectFn!: (err: Error) => void;
        const promise = new Promise<UploadDocumentResponse>((resolve, reject) => {
          resolveFn = resolve;
          rejectFn = reject;
        });
        deferreds.set(documentId, {
          resolve: (res) => {
            active.delete(documentId);
            resolveFn(res);
          },
          reject: (err) => {
            active.delete(documentId);
            rejectFn(err);
          },
          onProgress,
        });
        return {
          abort: () => {
            active.delete(documentId);
            rejectFn(new Error("aborted"));
          },
          promise,
        };
      },
      cancelOnServer: vi.fn().mockResolvedValue(null),
    };

    const orch = createUploadOrchestrator({ transport });
    const batchId = "11111111-1111-4111-1111-111111111111";
    const files = ["1.pdf", "2.pdf", "3.pdf", "4.pdf"].map((name) => makePdfFile(name));
    const fileSize = files[0]!.size;
    const docs = files.map((file, i) => makeDoc(`d${i + 1}`, file.name, file.size));

    orch.registerBatchFiles(
      batchId,
      docs.map((d, i) => ({ documentId: d.id, file: files[i]! })),
    );
    orch.startBatch(batchId, docs);

    expect(active.size).toBe(2);
    expect(peakActive).toBe(2);
    expect(orch.getBatchEntries(batchId).get("d1")?.phase).toBe("uploading");
    expect(orch.getBatchEntries(batchId).get("d2")?.phase).toBe("uploading");
    expect(orch.getBatchEntries(batchId).get("d3")?.phase).toBe("queued");
    expect(orch.getBatchEntries(batchId).get("d4")?.phase).toBe("queued");

    deferreds.get("d1")!.onProgress(Math.floor(fileSize / 2), fileSize);
    expect(orch.getBatchEntries(batchId).get("d1")?.progressPercent).toBe(
      Math.round((Math.floor(fileSize / 2) / fileSize) * 100),
    );

    // Complete d1 -> d3 starts immediately, peak concurrency never exceeds 2
    deferreds.get("d1")!.resolve({
      document: makeDoc("d1", "1.pdf", fileSize, "uploaded"),
      batch: makeBatch("uploading"),
    });

    await waitFor(() => {
      expect(orch.getBatchEntries(batchId).get("d3")?.phase).toBe("uploading");
    });
    expect(peakActive).toBe(2);
    expect(orch.getBatchEntries(batchId).get("d4")?.phase).toBe("queued");
  });
});

describe("PersistedBatchView upload progress, cancel, retry, re-attach, and private retrieval", () => {
  beforeEach(() => {
    uploadOrchestrator.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    uploadOrchestrator.reset();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uploads up to 2 PDFs at a time via XHR, displays progress, handles server error + retry, and links private PDF retrieval", async () => {
    const f1 = makePdfFile("one.pdf");
    const f2 = makePdfFile("two.pdf");
    const f3 = makePdfFile("three.pdf");
    const batchId = "11111111-1111-4111-1111-111111111111";
    const docs = [
      makeDoc("22222222-2222-4222-2222-222222222222", "one.pdf", f1.size),
      makeDoc("33333333-3333-4333-3333-333333333333", "two.pdf", f2.size),
      makeDoc("44444444-4444-4444-4444-444444444444", "three.pdf", f3.size),
    ];

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith(`/api/batches/${batchId}`)) {
        return new Response(
          JSON.stringify({
            batch: makeBatch("uploading"),
            documents: docs,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith(`/api/documents/${docs[1]!.id}/cancel`)) {
        return new Response(
          JSON.stringify({
            document: makeDoc(docs[1]!.id, "two.pdf", f2.size, "failed", "Upload cancelled."),
            batch: makeBatch("uploading"),
            cancelled: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    interface FakeXhr {
      url: string;
      method: string;
      status: number;
      responseText: string;
      withCredentials: boolean;
      headers: Record<string, string>;
      upload: { onprogress: ((e: ProgressEvent) => void) | null };
      onload: (() => void) | null;
      onerror: (() => void) | null;
      onabort: (() => void) | null;
      open: (m: string, u: string) => void;
      setRequestHeader: (k: string, v: string) => void;
      send: () => void;
      abort: () => void;
    }

    const xhrs: FakeXhr[] = [];
    class MockXMLHttpRequest implements FakeXhr {
      url = "";
      method = "";
      status = 200;
      responseText = "";
      withCredentials = false;
      headers: Record<string, string> = {};
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(m: string, u: string) {
        this.method = m;
        this.url = u;
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v;
      }
      send() {
        xhrs.push(this);
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest as unknown as typeof XMLHttpRequest);

    uploadOrchestrator.registerBatchFiles(batchId, [
      { documentId: docs[0]!.id, file: f1 },
      { documentId: docs[1]!.id, file: f2 },
      { documentId: docs[2]!.id, file: f3 },
    ]);

    render(<PersistedBatchView batchId={batchId} />);

    // Wait for batch load + first 2 XHRs started (3rd remains queued)
    await waitFor(() => {
      expect(xhrs).toHaveLength(2);
    });
    expect(screen.getByText(/Queued — waiting for an open upload slot/i)).toBeInTheDocument();

    // Update progress on first file
    act(() => {
      xhrs[0]!.upload.onprogress?.({
        lengthComputable: true,
        loaded: Math.floor(f1.size / 2),
        total: f1.size,
      } as ProgressEvent);
    });

    await waitFor(() => {
      const bar = screen.getByRole("progressbar", { name: "Upload progress for one.pdf" });
      expect(bar).toHaveAttribute(
        "aria-valuenow",
        String(Math.round((Math.floor(f1.size / 2) / f1.size) * 100)),
      );
    });

    // Complete first XHR -> third file begins uploading
    act(() => {
      xhrs[0]!.status = 200;
      xhrs[0]!.responseText = JSON.stringify({
        document: makeDoc(docs[0]!.id, "one.pdf", f1.size, "uploaded"),
        batch: makeBatch("uploading"),
      });
      xhrs[0]!.onload?.();
    });

    await waitFor(() => {
      expect(xhrs).toHaveLength(3);
    });
    expect(screen.getByRole("button", { name: "View one.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download one.pdf" })).toBeInTheDocument();

    // Fail second XHR -> displays server error message and offers Retry button
    act(() => {
      xhrs[1]!.status = 502;
      xhrs[1]!.responseText = JSON.stringify({
        error: "Could not store PDF in object storage.",
        code: "STORAGE_UPLOAD_FAILED",
      });
      xhrs[1]!.onload?.();
    });

    await waitFor(() => {
      expect(screen.getByText("Could not store PDF in object storage.")).toBeInTheDocument();
    });

    const rowTwo = screen.getByText("two.pdf").closest("li")!;
    const retryBtn = within(rowTwo).getByRole("button", { name: "Retry upload for two.pdf" });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(xhrs).toHaveLength(4);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/documents/${docs[1]!.id}/cancel`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("allows cancelling a stranded server-side uploading state after reload", async () => {
    const batchId = "11111111-1111-4111-1111-111111111111";
    const docId = "22222222-2222-4222-2222-222222222222";
    const docs = [makeDoc(docId, "stalled.pdf", 31, "uploading")];

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        if (url.endsWith(`/api/batches/${batchId}`)) {
          return new Response(JSON.stringify({ batch: makeBatch("uploading"), documents: docs }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith(`/api/documents/${docId}/cancel`)) {
          return new Response(
            JSON.stringify({
              document: makeDoc(docId, "stalled.pdf", 31, "failed", "Upload cancelled."),
              batch: makeBatch("failed"),
              cancelled: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<PersistedBatchView batchId={batchId} />);

    const cancelBtn = await screen.findByRole("button", { name: "Cancel upload for stalled.pdf" });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Upload PDF for stalled.pdf" }),
      ).toBeInTheDocument();
    });
  });

  it("allows re-attaching a matching PDF after page reload and rejects mismatched size before upload", async () => {
    const expectedSize = 31;
    const batchId = "11111111-1111-4111-1111-111111111111";
    const docId = "22222222-2222-4222-2222-222222222222";
    const docs = [makeDoc(docId, "bill.pdf", expectedSize, "failed", "Upload interrupted.")];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            batch: makeBatch("failed"),
            documents: docs,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(<PersistedBatchView batchId={batchId} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Upload PDF for bill.pdf" })).toBeInTheDocument();
    });

    const row = screen.getByText("bill.pdf").closest("li")!;
    const input = row.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    // Selecting a PDF with different byte size is rejected immediately client-side
    const wrongSized = makePdfFile("bill.pdf", "%PDF-1.7\ndifferent-length-content");
    expect(wrongSized.size).not.toBe(expectedSize);
    fireEvent.change(input, { target: { files: [wrongSized] } });

    await waitFor(() => {
      expect(screen.getByText(/does not match this document record/i)).toBeInTheDocument();
    });
  });

  it("distinguishes client abort from server cancellation confirmation and supports Confirm cancel recovery", async () => {
    const batchId = "11111111-1111-4111-1111-111111111111";
    const docId = "22222222-2222-4222-2222-222222222222";
    const f1 = makePdfFile("cancel-test.pdf");
    const docs = [makeDoc(docId, "cancel-test.pdf", f1.size)];

    let cancelAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        if (url.endsWith(`/api/batches/${batchId}`)) {
          return new Response(JSON.stringify({ batch: makeBatch("uploading"), documents: docs }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith(`/api/documents/${docId}/cancel`)) {
          cancelAttempts += 1;
          if (cancelAttempts === 1) {
            return new Response(JSON.stringify({ error: "Upstream unavailable" }), { status: 503 });
          }
          return new Response(
            JSON.stringify({
              document: makeDoc(docId, "cancel-test.pdf", f1.size, "failed", "Upload cancelled."),
              batch: makeBatch("failed"),
              cancelled: true,
              serverConfirmed: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    class MockAbortXhr {
      upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send() {}
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockAbortXhr as unknown as typeof XMLHttpRequest);

    uploadOrchestrator.registerBatchFiles(batchId, [{ documentId: docId, file: f1 }]);
    render(<PersistedBatchView batchId={batchId} />);

    const cancelBtn = await screen.findByRole("button", {
      name: "Cancel upload for cancel-test.pdf",
    });
    fireEvent.click(cancelBtn);

    // First cancel call failed -> UI explicitly states browser aborted but server unconfirmed
    await waitFor(() => {
      expect(
        screen.getByText(
          /Browser upload aborted, but server cancellation could not be confirmed yet/i,
        ),
      ).toBeInTheDocument();
    });
    const confirmCancelBtn = screen.getByRole("button", {
      name: "Confirm server cancellation for cancel-test.pdf",
    });
    fireEvent.click(confirmCancelBtn);

    await waitFor(() => {
      expect(screen.getByText("Cancellation confirmed by server.")).toBeInTheDocument();
    });
  });

  it("handles batch finalization conflicts, incomplete batch confirmation, sealed state, and batch deletion", async () => {
    const batchId = "11111111-1111-4111-1111-111111111111";
    const doc1Id = "22222222-2222-4222-2222-222222222222";
    const doc2Id = "33333333-3333-4333-8333-333333333333";
    const docs = [
      makeDoc(doc1Id, "done.pdf", 40, "uploaded"),
      makeDoc(doc2Id, "pending.pdf", 40, "pending_upload"),
    ];

    let finalizeCalls = 0;
    const onDeleted = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        if (url.endsWith(`/api/batches/${batchId}`) && (!init?.method || init.method === "GET")) {
          return new Response(
            JSON.stringify({
              batch: { ...makeBatch("uploading"), finalizedAt: null },
              documents: docs,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/batches/${batchId}/finalize`)) {
          finalizeCalls += 1;
          if (finalizeCalls === 1) {
            return new Response(
              JSON.stringify({
                error: "Some documents in this batch have not finished uploading yet.",
                code: "BATCH_HAS_UNRESOLVED_DOCUMENTS",
              }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              batch: {
                ...makeBatch("partial"),
                finalizedAt: "2026-11-26T12:00:00Z",
              },
              documents: [
                docs[0],
                makeDoc(
                  doc2Id,
                  "pending.pdf",
                  40,
                  "failed",
                  "Upload did not complete before batch finalization.",
                ),
              ],
              alreadyFinalized: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/batches/${batchId}`) && init?.method === "DELETE") {
          return new Response(JSON.stringify({ deleted: true, batchId, cleanupJobsQueued: 1 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<PersistedBatchView batchId={batchId} onDeleted={onDeleted} />);

    const finalizeBtn = await screen.findByRole("button", { name: /Finalize batch/i });
    fireEvent.click(finalizeBtn);

    // 409 BATCH_HAS_UNRESOLVED_DOCUMENTS opens explicit confirmation dialog
    const finalizeAnywayBtn = await screen.findByRole("button", { name: "Finalize anyway" });
    fireEvent.click(finalizeAnywayBtn);

    await waitFor(() => {
      expect(screen.getByText(/Batch finalized as partial/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Finalize batch/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Upload PDF for pending.pdf/i }),
    ).not.toBeInTheDocument();

    // Delete batch via ConfirmDialog
    const deleteTrigger = screen.getByRole("button", { name: "Delete batch Phase 4 UI Batch" });
    fireEvent.click(deleteTrigger);
    const confirmDeleteBtn = await screen.findByRole("button", { name: "Delete batch" });
    fireEvent.click(confirmDeleteBtn);

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
  });
});
