import "@tanstack/react-start/server-only";
import { HttpError } from "./env";
import { hasPdfSignature, MAX_FILE_BYTES, PDF_SIGNATURE_BYTES } from "@/lib/gathr/ingestion-types";

type FixedLengthStreamCtor = new (
  expectedLength: number,
) => TransformStream<Uint8Array, Uint8Array>;

export interface PreparedPdfUploadStream {
  stream: ReadableStream<Uint8Array>;
  abortSignal: AbortSignal;
  getState: () => { bytesRead: number; error: Error | null };
  waitForCompletion: () => Promise<void>;
}

function getFixedLengthStreamCtor(): FixedLengthStreamCtor | undefined {
  const ctor = (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream;
  return typeof ctor === "function" ? (ctor as FixedLengthStreamCtor) : undefined;
}

function createSizeError(nextBytes: number, expectedSize: number, maxSize: number): HttpError {
  if (nextBytes > maxSize) {
    return new HttpError(413, "Uploaded file exceeds the 50 MB limit.", "FILE_TOO_LARGE");
  }
  return new HttpError(
    400,
    `Uploaded file size does not match expected size (${expectedSize} bytes).`,
    "SIZE_MISMATCH",
  );
}

/**
 * Inspects leading bytes for emptiness and %PDF- magic signature, then returns
 * a streaming body that counts every chunk against expectedSize and maxSize
 * without buffering the full payload in memory.
 */
export async function preparePdfUploadStream(params: {
  body: ReadableStream<Uint8Array> | null;
  expectedSize: number;
  maxSize?: number;
  incomingSignal?: AbortSignal | undefined;
}): Promise<PreparedPdfUploadStream> {
  const { body, expectedSize, maxSize = MAX_FILE_BYTES, incomingSignal } = params;
  if (!body) {
    throw new HttpError(400, "Uploaded file is empty.", "EMPTY_FILE");
  }

  const maxAllowed = Math.min(expectedSize, maxSize);
  const reader = body.getReader();
  reader.closed.catch(() => {});
  const headChunks: Uint8Array[] = [];
  let totalRead = 0;

  try {
    while (totalRead < PDF_SIGNATURE_BYTES.length) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const nextBytes = totalRead + value.byteLength;
      if (nextBytes > maxAllowed) {
        await reader.cancel().catch(() => {});
        throw createSizeError(nextBytes, expectedSize, maxSize);
      }

      headChunks.push(value);
      totalRead = nextBytes;
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }

  if (totalRead === 0) {
    await reader.cancel().catch(() => {});
    throw new HttpError(400, "Uploaded file is empty.", "EMPTY_FILE");
  }

  const headerBytes = new Uint8Array(Math.min(PDF_SIGNATURE_BYTES.length, totalRead));
  let offset = 0;
  for (const chunk of headChunks) {
    const needed = headerBytes.byteLength - offset;
    if (needed <= 0) break;
    const slice = chunk.subarray(0, needed);
    headerBytes.set(slice, offset);
    offset += slice.byteLength;
  }

  if (!hasPdfSignature(headerBytes)) {
    await reader.cancel().catch(() => {});
    throw new HttpError(400, "Invalid PDF file signature.", "INVALID_PDF_SIGNATURE");
  }

  const abortController = new AbortController();
  if (incomingSignal) {
    if (incomingSignal.aborted) {
      abortController.abort(incomingSignal.reason);
    } else {
      incomingSignal.addEventListener(
        "abort",
        () => {
          abortController.abort(incomingSignal.reason);
        },
        { once: true },
      );
    }
  }

  const state: { bytesRead: number; error: Error | null } = {
    bytesRead: totalRead,
    error: null,
  };

  const FixedStream = getFixedLengthStreamCtor();
  if (FixedStream) {
    const fixed = new FixedStream(expectedSize);
    const writer = fixed.writable.getWriter();

    const onAbortFixed = () => {
      const reason =
        abortController.signal.reason instanceof Error
          ? abortController.signal.reason
          : new HttpError(400, "Upload aborted.", "STREAM_ABORTED");
      if (!state.error) state.error = reason;
      reader.cancel(reason).catch(() => {});
      writer.abort(reason).catch(() => {});
    };
    abortController.signal.addEventListener("abort", onAbortFixed, { once: true });

    const pumpPromise = (async () => {
      try {
        for (const chunk of headChunks) {
          if (abortController.signal.aborted) {
            throw state.error ?? new HttpError(400, "Upload stream aborted.", "STREAM_ABORTED");
          }
          await writer.write(chunk);
        }
        while (true) {
          if (abortController.signal.aborted) {
            throw state.error ?? new HttpError(400, "Upload stream aborted.", "STREAM_ABORTED");
          }
          const { done, value } = await reader.read();
          if (done) {
            if (state.bytesRead !== expectedSize) {
              throw createSizeError(state.bytesRead, expectedSize, maxSize);
            }
            await writer.close();
            break;
          }
          if (!value || value.byteLength === 0) continue;
          const nextBytes = state.bytesRead + value.byteLength;
          if (nextBytes > maxAllowed) {
            throw createSizeError(nextBytes, expectedSize, maxSize);
          }
          state.bytesRead = nextBytes;
          await writer.write(value);
        }
      } catch (err) {
        const failure = err instanceof Error ? err : new Error("Upload stream failed.");
        state.error = failure;
        await reader.cancel(failure).catch(() => {});
        await writer.abort(failure).catch(() => {});
        abortController.abort(failure);
        throw failure;
      } finally {
        abortController.signal.removeEventListener("abort", onAbortFixed);
      }
    })();

    // Prevent unhandled rejection if consumer aborts before awaiting waitForCompletion.
    pumpPromise.catch(() => {});

    // Wrap cancellation on fixed.readable to propagate to abortController and pumpPromise
    const readable = fixed.readable;
    const originalCancel = readable.cancel.bind(readable);
    readable.cancel = async (reason) => {
      const err =
        reason instanceof Error
          ? reason
          : new HttpError(400, "Upload stream cancelled.", "STREAM_CANCELLED");
      if (!state.error) state.error = err;
      abortController.abort(err);
      await reader.cancel(err).catch(() => {});
      return originalCancel(reason);
    };

    return {
      stream: readable,
      abortSignal: abortController.signal,
      getState: () => ({ ...state }),
      waitForCompletion: () => pumpPromise,
    };
  }

  let headIndex = 0;
  let completed = false;
  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  completionPromise.catch(() => {});

  const onAbortFallback = () => {
    const err =
      abortController.signal.reason instanceof Error
        ? abortController.signal.reason
        : new HttpError(400, "Upload stream aborted.", "STREAM_ABORTED");
    if (!completed && !state.error) {
      state.error = err;
      completed = true;
      rejectDone(err);
    }
    reader.cancel(err).catch(() => {});
  };
  abortController.signal.addEventListener("abort", onAbortFallback, { once: true });
  completionPromise
    .finally(() => {
      abortController.signal.removeEventListener("abort", onAbortFallback);
    })
    .catch(() => {});

  const failStream = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    err: Error,
  ) => {
    if (!state.error) state.error = err;
    await reader.cancel(err).catch(() => {});
    abortController.abort(err);
    try {
      controller.error(err);
    } catch {
      // Stream may already be errored or closed.
    }
    if (!completed) {
      completed = true;
      rejectDone(err);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (abortController.signal.aborted) {
        const abortErr =
          state.error ?? new HttpError(400, "Upload stream aborted.", "STREAM_ABORTED");
        await failStream(controller, abortErr);
        return;
      }

      if (headIndex < headChunks.length) {
        const nextHead = headChunks[headIndex++];
        if (nextHead) controller.enqueue(nextHead);
        return;
      }

      try {
        while (true) {
          if (abortController.signal.aborted) {
            const abortErr =
              state.error ?? new HttpError(400, "Upload stream aborted.", "STREAM_ABORTED");
            await failStream(controller, abortErr);
            return;
          }

          const { done, value } = await reader.read();
          if (done) {
            if (state.bytesRead !== expectedSize) {
              await failStream(controller, createSizeError(state.bytesRead, expectedSize, maxSize));
              return;
            }
            controller.close();
            if (!completed) {
              completed = true;
              resolveDone();
            }
            return;
          }
          if (!value || value.byteLength === 0) continue;

          const nextBytes = state.bytesRead + value.byteLength;
          if (nextBytes > maxAllowed) {
            await failStream(controller, createSizeError(nextBytes, expectedSize, maxSize));
            return;
          }
          state.bytesRead = nextBytes;
          controller.enqueue(value);
          return;
        }
      } catch (err) {
        const failure = err instanceof Error ? err : new Error("Upload stream failed.");
        await failStream(controller, failure);
      }
    },
    async cancel(reason) {
      const err =
        reason instanceof Error
          ? reason
          : new HttpError(400, "Upload stream cancelled.", "STREAM_CANCELLED");
      if (!completed && !state.error) {
        state.error = err;
        completed = true;
        rejectDone(err);
      }
      abortController.abort(err);
      await reader.cancel(reason).catch(() => {});
    },
  });

  return {
    stream,
    abortSignal: abortController.signal,
    getState: () => ({ ...state }),
    waitForCompletion: () => completionPromise,
  };
}
