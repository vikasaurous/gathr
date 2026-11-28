import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockToast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
);

vi.mock("sonner", () => ({
  toast: mockToast,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode; [k: string]: unknown }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useRouteContext: () => ({
      session: { user: { id: "u-ui", name: "Kavya Rao", email: "kavya@example.com" } },
      plan: "free",
    }),
  }),
}));

import { PersistedBatchView } from "@/components/gathr/persisted-batch-view";
import type {
  DocumentReviewStatus,
  PersistedBatch,
  PersistedDocument,
} from "@/lib/gathr/ingestion-types";
import { uploadOrchestrator } from "@/lib/gathr/upload-orchestrator";
import { Overview } from "@/routes/app.index";
import { Invoices } from "@/routes/app.invoices";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const DOC1_ID = "22222222-2222-4222-8222-222222222222";
const DOC2_ID = "33333333-3333-4333-8333-333333333333";

function makeBatch(finalizedAt: string | null = "2026-11-27T10:05:00Z"): PersistedBatch {
  return {
    id: BATCH_ID,
    name: "November Audit Batch",
    status: "partial",
    finalizedAt,
    createdAt: "2026-11-27T10:00:00Z",
    updatedAt: "2026-11-27T10:05:00Z",
  };
}

function makeDoc(
  id: string,
  filename: string,
  status: PersistedDocument["status"] = "uploaded",
  reviewStatus: DocumentReviewStatus | null = null,
  reviewVersion = 0,
): PersistedDocument {
  return {
    id,
    batchId: BATCH_ID,
    originalFilename: filename,
    mimeType: "application/pdf",
    fileSizeBytes: 24,
    status,
    reviewStatus,
    reviewVersion,
    reviewUpdatedAt: reviewStatus ? "2026-11-27T10:06:00Z" : null,
    pageCount: null,
    errorMessage: status === "failed" ? "Upload failed." : null,
    uploadedAt: status === "uploaded" ? "2026-11-27T10:01:00Z" : null,
    createdAt: "2026-11-27T10:00:00Z",
  };
}

function makePdfBytes(): string {
  return "%PDF-1.7\n% ok\n%%EOF\n";
}

describe("Phase 7 — Truthful review UI, concurrency conflict recovery, and label consistency", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    uploadOrchestrator.reset();
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => "blob:https://app.test/mock-pdf");
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

  it("separates upload vs review status, never displays uncaptured fields, avoids optimistic approval, and persists across reload", async () => {
    let serverDoc1 = makeDoc(DOC1_ID, "vendor-invoice-01.pdf", "uploaded", null, 0);
    const serverDoc2 = makeDoc(DOC2_ID, "failed-scan.pdf", "failed", null, 0);

    let resolveApprove!: (res: Response) => void;
    const approveStarted = new Promise<void>((resolve) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.endsWith(`/api/batches/${BATCH_ID}`)) {
            return new Response(
              JSON.stringify({ batch: makeBatch(), documents: [serverDoc1, serverDoc2] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (
            url.endsWith(`/api/documents/${DOC1_ID}`) &&
            (!init?.method || init.method === "GET")
          ) {
            return new Response(
              JSON.stringify({
                batch: makeBatch(),
                document: serverDoc1,
                reviewEvents:
                  serverDoc1.reviewVersion && serverDoc1.reviewVersion > 0
                    ? [
                        {
                          id: "ev-1",
                          documentId: DOC1_ID,
                          fromReviewStatus: null,
                          toReviewStatus: serverDoc1.reviewStatus,
                          actorName: "Kavya Rao",
                          createdAt: "2026-11-27T10:10:00Z",
                        },
                      ]
                    : [],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.endsWith(`/api/documents/${DOC1_ID}/content`)) {
            return new Response(makePdfBytes(), {
              status: 200,
              headers: { "Content-Type": "application/pdf" },
            });
          }
          if (url.endsWith(`/api/documents/${DOC1_ID}/review`) && init?.method === "POST") {
            resolve();
            return await new Promise<Response>((resFn) => {
              resolveApprove = resFn;
            });
          }
          if (url.endsWith("/api/exports")) {
            return new Response("id,filename\n1,persisted-bill.pdf", {
              status: 200,
              headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": 'attachment; filename="gathr_documents.csv"',
                "X-Gathr-Export-Status": "complete",
                "X-Gathr-Export-Included-Count": "2",
              },
            });
          }
          return new Response("{}", { status: 404 });
        }),
      );
    });

    render(<PersistedBatchView batchId={BATCH_ID} />);

    // Row 1 shows Uploaded + Unreviewed + Review button; failed Row 2 has NO Review button
    const row1 = (await screen.findByText("vendor-invoice-01.pdf")).closest("li")!;
    const row2 = screen.getByText("failed-scan.pdf").closest("li")!;
    expect(within(row1).getByText("Uploaded")).toBeInTheDocument();
    expect(within(row1).getByText("Unreviewed")).toBeInTheDocument();
    expect(within(row2).getByText("Upload failed")).toBeInTheDocument();
    expect(within(row2).queryByRole("button", { name: /Review/i })).not.toBeInTheDocument();

    // Open Review Workbench and wait for initial server detail refresh to settle
    fireEvent.click(within(row1).getByRole("button", { name: "Review vendor-invoice-01.pdf" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByTitle("PDF preview for vendor-invoice-01.pdf"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(dialog).getByRole("button", { name: "Refresh document review state" }),
      ).toBeEnabled();
    });

    // Acceptance check 9: No uncaptured invoice fields rendered anywhere
    expect(within(dialog).queryByText(/GSTIN/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Taxable value/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/CGST/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Supplier name/i)).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(/No invoice fields are extracted automatically/i),
    ).toBeInTheDocument();

    // Click Approve -> NO optimistic Verified before server confirmation
    const approveBtn = within(dialog).getByRole("button", { name: "Approve document" });
    fireEvent.click(approveBtn);
    await approveStarted;
    expect(await within(dialog).findByRole("button", { name: /Saving/i })).toBeDisabled();
    expect(within(dialog).queryByText("Verified")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Unreviewed")).toBeInTheDocument();

    // Server confirms Verified
    serverDoc1 = makeDoc(DOC1_ID, "vendor-invoice-01.pdf", "uploaded", "verified", 1);
    resolveApprove(
      new Response(
        JSON.stringify({
          document: serverDoc1,
          batch: makeBatch(),
          reviewEvents: [
            {
              id: "ev-1",
              documentId: DOC1_ID,
              fromReviewStatus: null,
              toReviewStatus: "verified",
              actorName: "Kavya Rao",
              createdAt: "2026-11-27T10:10:00Z",
            },
          ],
          idempotentReplay: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(await within(dialog).findByText("Verified")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Return to review" })).toBeInTheDocument();

    // Simulate reload -> remount reads server state and preserves Verified
    cleanup();
    render(<PersistedBatchView batchId={BATCH_ID} />);
    const reloadedRow = (await screen.findByText("vendor-invoice-01.pdf")).closest("li")!;
    expect(within(reloadedRow).getByText("Verified")).toBeInTheDocument();
  });

  it("handles 409 REVIEW_STATE_CONFLICT, network retry with preserved Idempotency-Key, confirmation dialogs, and review filters", async () => {
    let serverDoc1 = makeDoc(DOC1_ID, "conflict-doc.pdf", "uploaded", null, 0);
    const serverDoc2 = makeDoc(DOC2_ID, "other-doc.pdf", "uploaded", "skipped", 1);
    const seenKeys: string[] = [];
    let reviewCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/batches/${BATCH_ID}`)) {
          return new Response(
            JSON.stringify({ batch: makeBatch(), documents: [serverDoc1, serverDoc2] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/documents/${DOC1_ID}`) && (!init?.method || init.method === "GET")) {
          return new Response(
            JSON.stringify({ batch: makeBatch(), document: serverDoc1, reviewEvents: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/documents/${DOC1_ID}/content`)) {
          return new Response(makePdfBytes(), {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
        }
        if (url.endsWith(`/api/documents/${DOC1_ID}/review`) && init?.method === "POST") {
          reviewCalls += 1;
          const headers = new Headers(init.headers);
          seenKeys.push(headers.get("idempotency-key") ?? "");

          if (reviewCalls === 1) {
            // 1st click: simulate another tab rejected it concurrently
            serverDoc1 = makeDoc(DOC1_ID, "conflict-doc.pdf", "uploaded", "rejected", 1);
            return new Response(
              JSON.stringify({
                error: "This document's review state changed in another session.",
                code: "REVIEW_STATE_CONFLICT",
                currentDocument: serverDoc1,
              }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
          if (reviewCalls === 2) {
            // 2nd click (Return to review): transient network error
            throw new TypeError("Network offline");
          }
          // 3rd attempt (Retry decision): succeeds with same Idempotency-Key
          serverDoc1 = makeDoc(DOC1_ID, "conflict-doc.pdf", "uploaded", "needs_review", 2);
          return new Response(
            JSON.stringify({
              document: serverDoc1,
              batch: makeBatch(),
              reviewEvents: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/exports")) {
          return new Response("id,filename\n1,persisted-bill.pdf", {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="gathr_documents.csv"',
              "X-Gathr-Export-Status": "complete",
              "X-Gathr-Export-Included-Count": "2",
            },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<PersistedBatchView batchId={BATCH_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review conflict-doc.pdf" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(
        within(dialog).getByRole("button", { name: "Refresh document review state" }),
      ).toBeEnabled();
    });

    // 1. Stale Approve -> server returns 409 conflict with Rejected -> UI updates to Rejected and shows conflict banner
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve document" }));
    expect(
      await within(dialog).findByText(/review state changed in another session/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Rejected")).toBeInTheDocument();

    // 2. Return to review fails on network -> Retry decision reuses exact same Idempotency-Key
    fireEvent.click(within(dialog).getByRole("button", { name: "Return to review" }));
    const retryBtn = await within(dialog).findByRole("button", { name: "Retry decision" });
    fireEvent.click(retryBtn);

    expect(await within(dialog).findByText("Needs review")).toBeInTheDocument();
    expect(seenKeys).toHaveLength(3);
    expect(seenKeys[1]).toBeTruthy();
    expect(seenKeys[2]).toBe(seenKeys[1]);

    // Close and verify review status filter on PersistedBatchView
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    const reviewSelect = screen.getByLabelText("Filter by review status");
    fireEvent.change(reviewSelect, { target: { value: "skipped" } });
    expect(screen.getByText("other-doc.pdf")).toBeInTheDocument();
    expect(screen.queryByText("conflict-doc.pdf")).not.toBeInTheDocument();
  });

  it("renders /app/invoices and /app Overview with persisted workspace data, canonical labels, and zero fabricated invoice fields", async () => {
    const docsPayload = {
      documents: [
        {
          ...makeDoc(DOC1_ID, "persisted-bill.pdf", "uploaded", "verified", 1),
          batchName: "November Audit Batch",
          batchStatus: "uploaded",
          batchFinalizedAt: null,
        },
        {
          ...makeDoc(DOC2_ID, "queued-bill.pdf", "uploaded", "rejected", 1),
          batchName: "November Audit Batch",
          batchStatus: "uploaded",
          batchFinalizedAt: null,
        },
      ],
      counts: {
        total: 2,
        uploaded: 2,
        unreviewed: 0,
        needsReview: 0,
        verified: 1,
        duplicate: 0,
        rejected: 1,
        skipped: 0,
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/documents?")) {
          return new Response(JSON.stringify(docsPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/api/batches")) {
          return new Response(
            JSON.stringify({
              batches: [
                {
                  ...makeBatch(),
                  documentCount: 2,
                  pendingCount: 0,
                  uploadedCount: 2,
                  failedCount: 0,
                  totalSizeBytes: 48,
                  verifiedCount: 1,
                  rejectedCount: 1,
                  unreviewedCount: 0,
                  needsReviewCount: 0,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/documents/${DOC1_ID}`)) {
          return new Response(
            JSON.stringify({
              batch: makeBatch(),
              document: docsPayload.documents[0],
              reviewEvents: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/exports")) {
          return new Response("id,filename\n1,persisted-bill.pdf", {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="gathr_documents.csv"',
              "X-Gathr-Export-Status": "complete",
              "X-Gathr-Export-Included-Count": "2",
            },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    const anchorSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<Invoices />);
    expect(await screen.findByText("persisted-bill.pdf")).toBeInTheDocument();
    expect(screen.getByText("queued-bill.pdf")).toBeInTheDocument();
    expect(screen.getAllByText("Verified").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Rejected").length).toBeGreaterThanOrEqual(1);

    // No fake extracted fields or demo suppliers
    expect(screen.queryByText(/GSTIN/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Northfield Stationers/i)).not.toBeInTheDocument();

    // CSV export triggers cleanly via PersistedExportDialog
    fireEvent.click(screen.getByRole("button", { name: "Export documents" }));
    fireEvent.click(screen.getByRole("button", { name: /download csv/i }));
    await waitFor(() => {
      expect(anchorSpy).toHaveBeenCalledTimes(1);
    });

    cleanup();
    render(<Overview />);
    expect(await screen.findByText("November Audit Batch")).toBeInTheDocument();
    expect(screen.queryByText("Demo data")).not.toBeInTheDocument();
    expect(screen.queryByText("October vendor bills")).not.toBeInTheDocument();
  });

  it("handles /app/invoices sheet retry with preserved Idempotency-Key, stale detail abort, Prev/Next history isolation, and ignores pending deep links", async () => {
    let sheetDoc = {
      ...makeDoc(DOC1_ID, "sheet-inv.pdf", "uploaded", null, 0),
      batchName: "November Audit Batch",
      batchStatus: "uploaded" as const,
      batchFinalizedAt: null,
    };
    const seenKeys: string[] = [];
    let sheetReviewAttempt = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/documents?")) {
          return new Response(
            JSON.stringify({
              documents: [sheetDoc],
              counts: {
                total: 1,
                uploaded: 1,
                unreviewed: sheetDoc.reviewStatus === null ? 1 : 0,
                needsReview: 0,
                verified: sheetDoc.reviewStatus === "verified" ? 1 : 0,
                duplicate: 0,
                rejected: 0,
                skipped: 0,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/documents/${DOC1_ID}`) && (!init?.method || init.method === "GET")) {
          return new Response(
            JSON.stringify({
              batch: makeBatch(),
              document: sheetDoc,
              reviewEvents:
                sheetDoc.reviewStatus === "verified"
                  ? [
                      {
                        id: "ev-sheet-1",
                        documentId: DOC1_ID,
                        fromReviewStatus: null,
                        toReviewStatus: "verified",
                        actorName: "Kavya Rao",
                        createdAt: "2026-11-27T10:15:00Z",
                      },
                    ]
                  : [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/documents/${DOC1_ID}/review`) && init?.method === "POST") {
          sheetReviewAttempt += 1;
          const headers = new Headers(init.headers);
          seenKeys.push(headers.get("idempotency-key") ?? "");
          if (sheetReviewAttempt === 1) {
            throw new TypeError("Transient offline error");
          }
          sheetDoc = { ...sheetDoc, reviewStatus: "verified", reviewVersion: 1 };
          return new Response(
            JSON.stringify({
              document: sheetDoc,
              batch: makeBatch(),
              reviewEvents: [
                {
                  id: "ev-sheet-1",
                  documentId: DOC1_ID,
                  fromReviewStatus: null,
                  toReviewStatus: "verified",
                  actorName: "Kavya Rao",
                  createdAt: "2026-11-27T10:15:00Z",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/exports")) {
          return new Response("id,filename\n1,persisted-bill.pdf", {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="gathr_documents.csv"',
              "X-Gathr-Export-Status": "complete",
              "X-Gathr-Export-Included-Count": "2",
            },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<Invoices />);
    const reviewBtn = await screen.findByRole("button", { name: "Review" });
    fireEvent.click(reviewBtn);

    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Approve document" }));
    const retryBtn = await within(sheet).findByRole("button", { name: "Retry decision" });
    fireEvent.click(retryBtn);

    expect(await within(sheet).findByText("Verified")).toBeInTheDocument();
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBeTruthy();
    expect(seenKeys[1]).toBe(seenKeys[0]);

    // Prev/Next isolation + ignoring pending_upload deep-link in PersistedBatchView
    cleanup();
    const docA = makeDoc(DOC1_ID, "doc-a.pdf", "uploaded", "verified", 1);
    const docB = makeDoc(DOC2_ID, "doc-b.pdf", "uploaded", null, 0);
    const pendingId = "44444444-4444-4444-8444-444444444444";
    const docPending = makeDoc(pendingId, "not-ready.pdf", "pending_upload", null, 0);
    let currentSelected: string | undefined = pendingId;

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/batches/${BATCH_ID}`)) {
          return new Response(
            JSON.stringify({ batch: makeBatch(), documents: [docA, docB, docPending] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/documents/${DOC1_ID}`)) {
          return new Response(
            JSON.stringify({
              batch: makeBatch(),
              document: docA,
              reviewEvents: [
                {
                  id: "ev-a",
                  documentId: DOC1_ID,
                  fromReviewStatus: null,
                  toReviewStatus: "verified",
                  actorName: "Kavya Rao",
                  createdAt: "2026-11-27T10:10:00Z",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith(`/api/documents/${DOC2_ID}`)) {
          return new Response(
            JSON.stringify({ batch: makeBatch(), document: docB, reviewEvents: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/content")) {
          return new Response(makePdfBytes(), {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
        }
        if (url.endsWith("/api/exports")) {
          return new Response("id,filename\n1,persisted-bill.pdf", {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="gathr_documents.csv"',
              "X-Gathr-Export-Status": "complete",
              "X-Gathr-Export-Included-Count": "2",
            },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    const { rerender } = render(
      <PersistedBatchView
        batchId={BATCH_ID}
        selectedDocId={currentSelected}
        onSelectDoc={(id) => {
          currentSelected = id;
        }}
      />,
    );
    expect(await screen.findByText("not-ready.pdf")).toBeInTheDocument();
    // Pending document deep link must NOT open review dialog
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Opening doc-a updates controlled selection and shows its 1 history item; navigating to doc-b clears to 0 history items
    fireEvent.click(screen.getByRole("button", { name: "Review doc-a.pdf" }));
    expect(currentSelected).toBe(DOC1_ID);
    rerender(
      <PersistedBatchView
        batchId={BATCH_ID}
        selectedDocId={DOC1_ID}
        onSelectDoc={(id) => {
          currentSelected = id;
        }}
      />,
    );
    const workbench = await screen.findByRole("dialog");
    expect(await within(workbench).findByText("Review history (1)")).toBeInTheDocument();

    fireEvent.click(within(workbench).getByRole("button", { name: "Next uploaded document" }));
    expect(currentSelected).toBe(DOC2_ID);
    rerender(
      <PersistedBatchView
        batchId={BATCH_ID}
        selectedDocId={DOC2_ID}
        onSelectDoc={(id) => {
          currentSelected = id;
        }}
      />,
    );
    expect(await within(workbench).findByText("Review history (0)")).toBeInTheDocument();
  });

  it("supports /app/invoices pagination beyond a single page via Load more documents", async () => {
    const doc1 = {
      ...makeDoc(DOC1_ID, "page-1-doc.pdf", "uploaded", "verified", 1),
      batchName: "Large Workspace Batch",
      batchStatus: "uploaded" as const,
      batchFinalizedAt: null,
    };
    const doc2 = {
      ...makeDoc(DOC2_ID, "page-2-doc.pdf", "uploaded", null, 0),
      batchName: "Large Workspace Batch",
      batchStatus: "uploaded" as const,
      batchFinalizedAt: null,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/documents?") && !url.includes("offset=1")) {
          return new Response(
            JSON.stringify({
              documents: [doc1],
              counts: {
                total: 2,
                uploaded: 2,
                unreviewed: 1,
                needsReview: 0,
                verified: 1,
                duplicate: 0,
                rejected: 0,
                skipped: 0,
              },
              filteredTotal: 2,
              hasMore: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/api/documents?") && url.includes("offset=1")) {
          return new Response(
            JSON.stringify({
              documents: [doc2],
              counts: {
                total: 2,
                uploaded: 2,
                unreviewed: 1,
                needsReview: 0,
                verified: 1,
                duplicate: 0,
                rejected: 0,
                skipped: 0,
              },
              filteredTotal: 2,
              hasMore: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/exports")) {
          return new Response("id,filename\n1,persisted-bill.pdf", {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="gathr_documents.csv"',
              "X-Gathr-Export-Status": "complete",
              "X-Gathr-Export-Included-Count": "2",
            },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(<Invoices />);
    expect(await screen.findByText("page-1-doc.pdf")).toBeInTheDocument();
    expect(screen.queryByText("page-2-doc.pdf")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 2 documents/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more documents" }));
    expect(await screen.findByText("page-2-doc.pdf")).toBeInTheDocument();
    expect(screen.getByText("page-1-doc.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more documents" })).not.toBeInTheDocument();
  });
});
