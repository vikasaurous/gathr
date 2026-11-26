import {
  PDF_MIME_TYPE,
  type CancelUploadResponse,
  type PersistedDocument,
  type UploadDocumentResponse,
} from "@/lib/gathr/ingestion-types";

/**
 * Phase 4 constraint: preserve controlled client concurrency limit of 2 unless
 * load testing justifies a deliberate change.
 */
export const MAX_CONCURRENT_UPLOADS = 2;

export type ClientUploadPhase =
  | "queued"
  | "uploading"
  | "uploaded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "cancel_unconfirmed";

export interface DocumentUploadEntry {
  documentId: string;
  batchId: string;
  file: File;
  phase: ClientUploadPhase;
  loadedBytes: number;
  totalBytes: number;
  progressPercent: number;
  errorMessage: string | null;
}

export interface UploadRequestHandle {
  abort(): void;
  promise: Promise<UploadDocumentResponse>;
}

export interface UploadTransport {
  upload(params: {
    documentId: string;
    file: File;
    onProgress: (loadedBytes: number, totalBytes: number) => void;
  }): UploadRequestHandle;
  cancelOnServer(
    documentId: string,
    attemptId?: string | null | undefined,
  ): Promise<CancelUploadResponse | null>;
}

export class ClientUploadError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly cancelled: boolean;

  constructor(message: string, options?: { status?: number; code?: string; cancelled?: boolean }) {
    super(message);
    this.name = "ClientUploadError";
    this.status = options?.status ?? 0;
    this.code = options?.code;
    this.cancelled = Boolean(options?.cancelled);
  }
}

export function createXhrUploadTransport(): UploadTransport {
  return {
    upload({ documentId, file, onProgress }) {
      const xhr = new XMLHttpRequest();
      let settled = false;

      const promise = new Promise<UploadDocumentResponse>((resolve, reject) => {
        xhr.open("PUT", `/api/documents/${encodeURIComponent(documentId)}/upload`, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Content-Type", PDF_MIME_TYPE);

        xhr.upload.onprogress = (event) => {
          const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
          onProgress(Math.min(event.loaded, total), total);
        };

        xhr.onload = () => {
          if (settled) return;
          settled = true;

          let parsed: unknown = null;
          try {
            parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          } catch {
            parsed = null;
          }

          if (xhr.status >= 200 && xhr.status < 300 && parsed && typeof parsed === "object") {
            onProgress(file.size, file.size);
            resolve(parsed as UploadDocumentResponse);
            return;
          }

          const errRec =
            parsed && typeof parsed === "object"
              ? (parsed as { error?: unknown; code?: unknown })
              : {};
          const serverMessage =
            typeof errRec.error === "string" && errRec.error
              ? errRec.error
              : xhr.status === 401
                ? "Your session has expired. Sign in again to upload this document."
                : `Upload failed with server status ${xhr.status || "error"}.`;
          const code = typeof errRec.code === "string" ? errRec.code : undefined;

          reject(
            new ClientUploadError(serverMessage, {
              status: xhr.status,
              ...(code ? { code } : {}),
            }),
          );
        };

        xhr.onerror = () => {
          if (settled) return;
          settled = true;
          reject(
            new ClientUploadError("Network error while uploading PDF. Please retry.", {
              status: 0,
              code: "NETWORK_ERROR",
            }),
          );
        };

        xhr.onabort = () => {
          if (settled) return;
          settled = true;
          reject(
            new ClientUploadError("Upload cancelled.", {
              status: 0,
              code: "UPLOAD_CANCELLED",
              cancelled: true,
            }),
          );
        };

        xhr.send(file);
      });

      return {
        abort: () => xhr.abort(),
        promise,
      };
    },

    async cancelOnServer(
      documentId: string,
      attemptId?: string | null | undefined,
    ): Promise<CancelUploadResponse | null> {
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/cancel`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: attemptId ? JSON.stringify({ attemptId }) : "{}",
        });
        if (!res.ok) return null;
        return (await res.json()) as CancelUploadResponse;
      } catch {
        return null;
      }
    },
  };
}

export type ServerUpdateCallback = (payload: {
  document: UploadDocumentResponse["document"];
  batch: UploadDocumentResponse["batch"];
}) => void;

const EMPTY_BATCH_MAP: ReadonlyMap<string, DocumentUploadEntry> = new Map();

export function createUploadOrchestrator(options?: {
  transport?: UploadTransport | undefined;
  maxConcurrent?: number | undefined;
}) {
  const transport = options?.transport ?? createXhrUploadTransport();
  const maxConcurrent = Math.max(1, options?.maxConcurrent ?? MAX_CONCURRENT_UPLOADS);

  const batches = new Map<string, Map<string, DocumentUploadEntry>>();
  const snapshotCache = new Map<string, ReadonlyMap<string, DocumentUploadEntry>>();
  const pendingQueue: Array<{ batchId: string; documentId: string }> = [];
  const activeHandles = new Map<string, UploadRequestHandle>();
  const batchCallbacks = new Map<string, ServerUpdateCallback>();
  const listeners = new Set<() => void>();

  function invalidateBatchSnapshot(batchId: string) {
    const map = batches.get(batchId);
    snapshotCache.set(batchId, map ? new Map(map) : EMPTY_BATCH_MAP);
  }

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  function setEntry(batchId: string, entry: DocumentUploadEntry) {
    let map = batches.get(batchId);
    if (!map) {
      map = new Map();
      batches.set(batchId, map);
    }
    map.set(entry.documentId, entry);
    invalidateBatchSnapshot(batchId);
    emit();
  }

  function enqueuePending(batchId: string, documentId: string) {
    const alreadyQueued = pendingQueue.some(
      (item) => item.batchId === batchId && item.documentId === documentId,
    );
    if (!alreadyQueued && !activeHandles.has(documentId)) {
      pendingQueue.push({ batchId, documentId });
    }
  }

  function removeFromPending(documentId: string) {
    for (let i = pendingQueue.length - 1; i >= 0; i--) {
      if (pendingQueue[i]?.documentId === documentId) {
        pendingQueue.splice(i, 1);
      }
    }
  }

  function drainQueue() {
    while (activeHandles.size < maxConcurrent && pendingQueue.length > 0) {
      const next = pendingQueue.shift();
      if (!next) break;
      const batchMap = batches.get(next.batchId);
      const entry = batchMap?.get(next.documentId);
      if (!entry || entry.phase !== "queued") continue;
      startSingleUpload(next.batchId, entry);
    }
  }

  function startSingleUpload(batchId: string, initialEntry: DocumentUploadEntry) {
    const documentId = initialEntry.documentId;
    setEntry(batchId, {
      ...initialEntry,
      phase: "uploading",
      loadedBytes: 0,
      totalBytes: initialEntry.file.size,
      progressPercent: 0,
      errorMessage: null,
    });

    const handle = transport.upload({
      documentId,
      file: initialEntry.file,
      onProgress: (loadedBytes, totalBytes) => {
        const current = batches.get(batchId)?.get(documentId);
        if (!current || current.phase !== "uploading") return;
        const safeTotal = totalBytes > 0 ? totalBytes : current.file.size;
        const pct = safeTotal > 0 ? Math.min(100, Math.round((loadedBytes / safeTotal) * 100)) : 0;
        setEntry(batchId, {
          ...current,
          loadedBytes,
          totalBytes: safeTotal,
          progressPercent: pct,
        });
      },
    });

    activeHandles.set(documentId, handle);

    void handle.promise
      .then((res) => {
        activeHandles.delete(documentId);
        const current = batches.get(batchId)?.get(documentId);
        if (current) {
          setEntry(batchId, {
            ...current,
            phase: "uploaded",
            loadedBytes: current.file.size,
            totalBytes: current.file.size,
            progressPercent: 100,
            errorMessage: null,
          });
        }
        batchCallbacks.get(batchId)?.(res);
      })
      .catch((err: unknown) => {
        activeHandles.delete(documentId);
        const current = batches.get(batchId)?.get(documentId);
        const isCancelled = err instanceof ClientUploadError && err.cancelled;
        const message =
          err instanceof Error && err.message ? err.message : "Upload failed. Please retry.";

        if (current) {
          const preserveCancelState =
            isCancelled &&
            (current.phase === "cancelling" ||
              current.phase === "cancelled" ||
              current.phase === "cancel_unconfirmed");
          if (!preserveCancelState) {
            setEntry(batchId, {
              ...current,
              phase: isCancelled ? "cancel_unconfirmed" : "failed",
              errorMessage: isCancelled
                ? "Browser upload aborted, awaiting server cancellation confirmation."
                : message,
            });
          }
        }

        if (!isCancelled && typeof globalThis.fetch === "function") {
          const maybeFetch = globalThis.fetch(`/api/batches/${encodeURIComponent(batchId)}`, {
            method: "GET",
            credentials: "same-origin",
          });
          if (maybeFetch && typeof maybeFetch.then === "function") {
            void maybeFetch
              .then(async (res) => {
                if (!res || !res.ok) return;
                const detail = (await res.json()) as {
                  batch?: UploadDocumentResponse["batch"];
                  documents?: UploadDocumentResponse["document"][];
                };
                const updatedDoc = detail.documents?.find((d) => d.id === documentId);
                if (detail.batch && updatedDoc) {
                  batchCallbacks.get(batchId)?.({
                    batch: detail.batch,
                    document: updatedDoc,
                  });
                }
              })
              .catch(() => {});
          }
        }
      })
      .finally(() => {
        drainQueue();
      });
  }

  return {
    registerBatchFiles(batchId: string, items: Array<{ documentId: string; file: File }>): void {
      if (items.length === 0) return;
      let map = batches.get(batchId);
      if (!map) {
        map = new Map();
        batches.set(batchId, map);
      }
      for (const { documentId, file } of items) {
        map.set(documentId, {
          documentId,
          batchId,
          file,
          phase: "queued",
          loadedBytes: 0,
          totalBytes: file.size,
          progressPercent: 0,
          errorMessage: null,
        });
      }
      invalidateBatchSnapshot(batchId);
      emit();
    },

    startBatch(
      batchId: string,
      serverDocs: PersistedDocument[],
      onServerUpdate?: ServerUpdateCallback,
    ): void {
      if (onServerUpdate) {
        batchCallbacks.set(batchId, onServerUpdate);
      }
      const map = batches.get(batchId);
      if (!map || map.size === 0) return;

      let changed = false;
      for (const doc of serverDocs) {
        const entry = map.get(doc.id);
        if (!entry) continue;

        if (doc.status === "uploaded") {
          if (entry.phase !== "uploaded") {
            map.set(doc.id, {
              ...entry,
              phase: "uploaded",
              loadedBytes: entry.file.size,
              totalBytes: entry.file.size,
              progressPercent: 100,
              errorMessage: null,
            });
            changed = true;
          }
          continue;
        }

        if (
          entry.phase === "queued" &&
          !activeHandles.has(doc.id) &&
          entry.file.size === doc.fileSizeBytes
        ) {
          enqueuePending(batchId, doc.id);
        }
      }

      if (changed) {
        invalidateBatchSnapshot(batchId);
        emit();
      }
      drainQueue();
    },

    async uploadFileForDocument(
      batchId: string,
      documentId: string,
      file: File,
      onServerUpdate?: ServerUpdateCallback,
    ): Promise<void> {
      if (onServerUpdate) {
        batchCallbacks.set(batchId, onServerUpdate);
      }
      if (activeHandles.has(documentId)) return;
      setEntry(batchId, {
        documentId,
        batchId,
        file,
        phase: "queued",
        loadedBytes: 0,
        totalBytes: file.size,
        progressPercent: 0,
        errorMessage: null,
      });
      const released = await transport.cancelOnServer(documentId);
      if (released) {
        batchCallbacks.get(batchId)?.({
          document: released.document,
          batch: released.batch,
        });
        if (released.document.status === "uploaded") {
          setEntry(batchId, {
            documentId,
            batchId,
            file,
            phase: "uploaded",
            loadedBytes: file.size,
            totalBytes: file.size,
            progressPercent: 100,
            errorMessage: null,
          });
          return;
        }
      }
      enqueuePending(batchId, documentId);
      drainQueue();
    },

    async retryDocument(
      batchId: string,
      documentId: string,
      onServerUpdate?: ServerUpdateCallback,
    ): Promise<boolean> {
      const existing = batches.get(batchId)?.get(documentId);
      if (!existing) return false;
      if (
        existing.phase === "uploading" ||
        existing.phase === "queued" ||
        existing.phase === "cancelling"
      ) {
        return false;
      }
      if (onServerUpdate) {
        batchCallbacks.set(batchId, onServerUpdate);
      }
      setEntry(batchId, {
        ...existing,
        phase: "queued",
        loadedBytes: 0,
        totalBytes: existing.file.size,
        progressPercent: 0,
        errorMessage: null,
      });

      const released = await transport.cancelOnServer(documentId);
      if (released) {
        batchCallbacks.get(batchId)?.({
          document: released.document,
          batch: released.batch,
        });
        if (released.document.status === "uploaded") {
          setEntry(batchId, {
            ...existing,
            phase: "uploaded",
            loadedBytes: existing.file.size,
            totalBytes: existing.file.size,
            progressPercent: 100,
            errorMessage: null,
          });
          return true;
        }
        if (released.batch.finalizedAt) {
          setEntry(batchId, {
            ...existing,
            phase: "failed",
            errorMessage: "Batch is finalized and no longer accepts retries.",
          });
          return false;
        }
      }

      enqueuePending(batchId, documentId);
      drainQueue();
      return true;
    },

    async cancelStuckServerUpload(
      batchId: string,
      documentId: string,
      onServerUpdate?: ServerUpdateCallback,
      attemptId?: string | null | undefined,
    ): Promise<CancelUploadResponse | null> {
      if (onServerUpdate) {
        batchCallbacks.set(batchId, onServerUpdate);
      }
      const serverState = await transport.cancelOnServer(documentId, attemptId);
      if (serverState) {
        const current = batches.get(batchId)?.get(documentId);
        if (current) {
          setEntry(batchId, {
            ...current,
            phase: serverState.document.status === "uploaded" ? "uploaded" : "cancelled",
            loadedBytes:
              serverState.document.status === "uploaded" ? current.file.size : current.loadedBytes,
            progressPercent:
              serverState.document.status === "uploaded" ? 100 : current.progressPercent,
            errorMessage:
              serverState.document.status === "uploaded"
                ? null
                : "Cancellation confirmed by server.",
          });
        }
        batchCallbacks.get(batchId)?.({
          document: serverState.document,
          batch: serverState.batch,
        });
      }
      return serverState;
    },

    async cancelDocument(
      batchId: string,
      documentId: string,
      onServerUpdate?: ServerUpdateCallback,
      attemptId?: string | null | undefined,
    ): Promise<void> {
      if (onServerUpdate) {
        batchCallbacks.set(batchId, onServerUpdate);
      }
      const wasQueued = pendingQueue.some(
        (item) => item.batchId === batchId && item.documentId === documentId,
      );
      removeFromPending(documentId);

      const handle = activeHandles.get(documentId);
      const existing = batches.get(batchId)?.get(documentId);

      if (wasQueued && !handle) {
        if (existing && existing.phase !== "uploaded") {
          setEntry(batchId, {
            ...existing,
            phase: "cancelled",
            errorMessage: "Queued upload cancelled before transfer began.",
          });
        }
        drainQueue();
        return;
      }

      if (existing && existing.phase !== "uploaded") {
        setEntry(batchId, {
          ...existing,
          phase: handle ? "cancelling" : "cancelling",
          errorMessage: "Browser upload aborted — awaiting server cancellation confirmation…",
        });
      }

      if (handle) {
        handle.abort();
        const serverState = await transport.cancelOnServer(documentId, attemptId);
        const latest = batches.get(batchId)?.get(documentId);
        if (serverState) {
          if (latest) {
            setEntry(batchId, {
              ...latest,
              phase: serverState.document.status === "uploaded" ? "uploaded" : "cancelled",
              loadedBytes:
                serverState.document.status === "uploaded" ? latest.file.size : latest.loadedBytes,
              progressPercent:
                serverState.document.status === "uploaded" ? 100 : latest.progressPercent,
              errorMessage:
                serverState.document.status === "uploaded"
                  ? null
                  : "Cancellation confirmed by server.",
            });
          }
          batchCallbacks.get(batchId)?.({
            document: serverState.document,
            batch: serverState.batch,
          });
        } else if (latest && latest.phase !== "uploaded") {
          setEntry(batchId, {
            ...latest,
            phase: "cancel_unconfirmed",
            errorMessage:
              "Browser upload aborted, but server cancellation could not be confirmed yet.",
          });
        }
      }
      drainQueue();
    },

    cancelBatchLocalUploads(batchId: string): void {
      for (let i = pendingQueue.length - 1; i >= 0; i--) {
        if (pendingQueue[i]?.batchId === batchId) {
          pendingQueue.splice(i, 1);
        }
      }
      const map = batches.get(batchId);
      if (map) {
        for (const [docId, entry] of map.entries()) {
          const handle = activeHandles.get(docId);
          if (handle) {
            handle.abort();
            activeHandles.delete(docId);
          }
          if (entry.phase !== "uploaded") {
            map.set(docId, {
              ...entry,
              phase: "cancelled",
              errorMessage: "Upload cancelled.",
            });
          }
        }
        invalidateBatchSnapshot(batchId);
        emit();
      }
    },

    unregisterCallback(batchId: string): void {
      batchCallbacks.delete(batchId);
    },

    getBatchEntries(batchId: string): ReadonlyMap<string, DocumentUploadEntry> {
      return snapshotCache.get(batchId) ?? EMPTY_BATCH_MAP;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getActiveCount(): number {
      return activeHandles.size;
    },

    reset(): void {
      for (const handle of activeHandles.values()) {
        handle.abort();
      }
      activeHandles.clear();
      pendingQueue.length = 0;
      batches.clear();
      snapshotCache.clear();
      batchCallbacks.clear();
      emit();
    },
  };
}

export const uploadOrchestrator = createUploadOrchestrator();
