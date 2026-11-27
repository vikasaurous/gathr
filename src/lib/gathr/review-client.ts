import { useSyncExternalStore } from "react";
import type {
  DocumentReviewStatus,
  PersistedDocument,
  ReviewDocumentResponse,
} from "@/lib/gathr/ingestion-types";

export type SubmitReviewResult =
  | { ok: true; data: ReviewDocumentResponse }
  | {
      ok: false;
      kind: "conflict";
      message: string;
      code: string;
      currentDocument?: PersistedDocument | undefined;
    }
  | { ok: false; kind: "unauthorized"; message: string }
  | { ok: false; kind: "not_found"; message: string }
  | { ok: false; kind: "error"; message: string };

export async function submitDocumentReviewDecision(params: {
  documentId: string;
  reviewStatus: DocumentReviewStatus;
  expectedReviewStatus: DocumentReviewStatus | null;
  expectedReviewVersion: number;
  idempotencyKey: string;
}): Promise<SubmitReviewResult> {
  const { documentId, reviewStatus, expectedReviewStatus, expectedReviewVersion, idempotencyKey } =
    params;

  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/review`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        reviewStatus,
        expectedReviewStatus,
        expectedReviewVersion,
      }),
    });

    if (res.status === 401) {
      return {
        ok: false,
        kind: "unauthorized",
        message: "Your session has expired. Please sign in again to record review decisions.",
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        kind: "not_found",
        message: "This document no longer exists in your workspace.",
      };
    }

    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      code?: unknown;
      currentDocument?: unknown;
    };

    if (res.status === 409) {
      const code = typeof body.code === "string" ? body.code : "REVIEW_STATE_CONFLICT";
      const message =
        typeof body.error === "string" && body.error
          ? body.error
          : "This document changed in another session. Refresh to view its current state.";
      const currentDocument =
        body.currentDocument && typeof body.currentDocument === "object"
          ? (body.currentDocument as PersistedDocument)
          : undefined;
      return {
        ok: false,
        kind: "conflict",
        message,
        code,
        currentDocument,
      };
    }

    if (!res.ok) {
      const message =
        typeof body.error === "string" && body.error
          ? body.error
          : "Could not save your review decision. Please try again.";
      return { ok: false, kind: "error", message };
    }

    return { ok: true, data: body as unknown as ReviewDocumentResponse };
  } catch {
    return {
      ok: false,
      kind: "error",
      message:
        "Network error while saving review decision. Your changes were not applied — please retry.",
    };
  }
}

let pendingReviewCount: number | null = null;
const summaryListeners = new Set<() => void>();

export function setPendingReviewBadgeCount(count: number | null): void {
  if (pendingReviewCount === count) return;
  pendingReviewCount = count;
  summaryListeners.forEach((l) => l());
}

export function usePendingReviewBadgeCount(): number | null {
  return useSyncExternalStore(
    (listener) => {
      summaryListeners.add(listener);
      return () => summaryListeners.delete(listener);
    },
    () => pendingReviewCount,
    () => null,
  );
}
