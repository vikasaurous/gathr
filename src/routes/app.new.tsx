import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FileDrop, type QueuedFile } from "@/components/gathr/file-drop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/gathr/format";
import {
  checkPdfFileMetadata,
  disambiguateBatchFilenames,
  hasValidPdfHeader,
  MAX_BATCH_NAME_LENGTH,
  MAX_FILES_PER_BATCH,
  sanitizeOriginalFilename,
  type CreateBatchResponse,
} from "@/lib/gathr/ingestion-types";

export const Route = createFileRoute("/app/new")({
  head: () => ({
    meta: [
      { title: "New batch | gathr" },
      {
        name: "description",
        content: "Select individual invoice PDFs to create and prepare a new document batch.",
      },
      { property: "og:title", content: "New batch — gathr" },
      {
        property: "og:description",
        content: "Select individual invoice PDFs to create and prepare a new document batch.",
      },
    ],
  }),
  component: NewBatch,
});

const OVER_LIMIT_ERROR = `Exceeds the ${MAX_FILES_PER_BATCH}-file batch limit.`;

function reconcileQueue(items: QueuedFile[]): QueuedFile[] {
  const validIndices = new Set<number>();
  const validSanitized: string[] = [];

  items.forEach((item, index) => {
    const withinLimit = index < MAX_FILES_PER_BATCH;
    const baseError = checkPdfFileMetadata(item.file);
    const hasContentError =
      Boolean(item.error) && item.error !== OVER_LIMIT_ERROR && item.error !== baseError;
    if (withinLimit && !baseError && !hasContentError) {
      validIndices.add(index);
      validSanitized.push(item.sanitizedName);
    }
  });

  const disambiguated = disambiguateBatchFilenames(validSanitized);
  let validCursor = 0;

  return items.map((item, index) => {
    const baseError = checkPdfFileMetadata(item.file);
    const overLimit = index >= MAX_FILES_PER_BATCH;
    let nextError = item.error;

    if (baseError) {
      nextError = baseError;
    } else if (overLimit) {
      nextError = OVER_LIMIT_ERROR;
    } else if (item.error === OVER_LIMIT_ERROR) {
      nextError = undefined;
    }

    const displayName = validIndices.has(index)
      ? (disambiguated[validCursor++] ?? item.sanitizedName)
      : item.sanitizedName || item.file.name;

    return {
      ...item,
      displayName,
      error: nextError,
    };
  });
}

export function NewBatch({ onCreated }: { onCreated?: ((batchId: string) => void) | undefined }) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{
    message: string;
    unauthorized?: boolean;
  } | null>(null);

  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function rotateIdempotencyKey() {
    idempotencyKeyRef.current = crypto.randomUUID();
  }

  function add(list: File[]) {
    if (submittingRef.current || list.length === 0) return;
    setSubmitError(null);
    rotateIdempotencyKey();

    const newItems: QueuedFile[] = list.map((file) => {
      const sanitizedName = sanitizeOriginalFilename(file.name) || file.name;
      const syncError = checkPdfFileMetadata(file);
      return {
        id: crypto.randomUUID(),
        file,
        sanitizedName,
        displayName: sanitizedName,
        validating: syncError === undefined,
        error: syncError,
      };
    });

    setFiles((cur) => reconcileQueue([...cur, ...newItems]));

    for (const item of newItems) {
      if (item.error !== undefined) continue;
      void hasValidPdfHeader(item.file)
        .then((isValid) => {
          if (!mountedRef.current) return;
          setFiles((cur) =>
            reconcileQueue(
              cur.map((existing) =>
                existing.id === item.id
                  ? {
                      ...existing,
                      validating: false,
                      error: isValid
                        ? existing.error
                        : "File is not a valid PDF (missing %PDF- signature).",
                    }
                  : existing,
              ),
            ),
          );
        })
        .catch(() => {
          if (!mountedRef.current) return;
          setFiles((cur) =>
            reconcileQueue(
              cur.map((existing) =>
                existing.id === item.id
                  ? {
                      ...existing,
                      validating: false,
                      error: "Could not read file header for validation.",
                    }
                  : existing,
              ),
            ),
          );
        });
    }
  }

  function removeFile(id: string) {
    if (submittingRef.current) return;
    setSubmitError(null);
    rotateIdempotencyKey();
    setFiles((cur) => reconcileQueue(cur.filter((x) => x.id !== id)));
  }

  function removeInvalid() {
    if (submittingRef.current) return;
    setSubmitError(null);
    rotateIdempotencyKey();
    setFiles((cur) => reconcileQueue(cur.filter((x) => !x.error).slice(0, MAX_FILES_PER_BATCH)));
  }

  function keepFirstLimit() {
    if (submittingRef.current) return;
    setSubmitError(null);
    rotateIdempotencyKey();
    setFiles((cur) => reconcileQueue(cur.slice(0, MAX_FILES_PER_BATCH)));
  }

  const isValidating = files.some((f) => f.validating);
  const invalidFiles = files.filter((f) => Boolean(f.error));
  const readyFiles = files.filter((f) => !f.error && !f.validating);
  const overLimitCount = Math.max(0, files.length - MAX_FILES_PER_BATCH);
  const totalReadyBytes = readyFiles.reduce((sum, item) => sum + item.file.size, 0);
  const canSubmit =
    !isSubmitting &&
    !isValidating &&
    files.length > 0 &&
    overLimitCount === 0 &&
    invalidFiles.length === 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const trimmedName = name.trim();
      const response = await fetch("/api/batches", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          ...(trimmedName ? { name: trimmedName } : {}),
          files: readyFiles.map((item) => ({
            filename: item.displayName,
            ...(item.file.type ? { mimeType: item.file.type } : {}),
            sizeBytes: item.file.size,
          })),
        }),
      });

      if (!response.ok) {
        let message = "Could not create batch on the server. Please try again.";
        try {
          const data = (await response.json()) as { error?: unknown };
          if (typeof data.error === "string" && data.error) {
            message = data.error;
          }
        } catch {
          // Keep generic safe message
        }

        if (mountedRef.current) {
          setSubmitError({
            message:
              response.status === 401
                ? "Your session has expired. Sign in again to create this batch."
                : message,
            unauthorized: response.status === 401,
          });
          setIsSubmitting(false);
        }
        submittingRef.current = false;
        return;
      }

      const created = (await response.json()) as CreateBatchResponse;
      toast.success(
        `Batch created with ${created.documents.length} PDF document${created.documents.length === 1 ? "" : "s"}`,
      );
      if (onCreated) {
        onCreated(created.batch.id);
      } else {
        await navigate({ to: "/app/batches/$id", params: { id: created.batch.id } });
      }
    } catch {
      if (mountedRef.current) {
        setSubmitError({
          message:
            "Network error while saving your batch. Your selected files are preserved — please try again.",
        });
        setIsSubmitting(false);
      }
      submittingRef.current = false;
    }
  }

  return (
    <div className="mx-auto max-w-[1080px] px-5 py-8 md:px-10 md:py-14">
      <p className="eyebrow">New batch</p>
      <h1 className="display mt-5 text-[52px] md:text-[72px]">
        Bring your documents <em>in.</em>
      </h1>
      <p className="mt-4 max-w-lg text-muted-foreground">
        Select up to {MAX_FILES_PER_BATCH} individual invoice PDFs. Each PDF becomes its own
        document inside the batch.
      </p>

      <form onSubmit={handleSubmit} className="mt-10 grid gap-10 lg:grid-cols-[1fr_340px]">
        <div>
          <FileDrop files={files} onAdd={add} onRemove={removeFile} disabled={isSubmitting} />

          {overLimitCount > 0 && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <p>
                  Batch limit exceeded: {files.length} files selected (maximum {MAX_FILES_PER_BATCH}
                  ). Remove {overLimitCount} file
                  {overLimitCount === 1 ? "" : "s"} to continue.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isSubmitting}
                onClick={keepFirstLimit}
              >
                Keep first {MAX_FILES_PER_BATCH}
              </Button>
            </div>
          )}

          {invalidFiles.length > 0 && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <p>
                  {invalidFiles.length} selected file{invalidFiles.length === 1 ? "" : "s"} cannot
                  be submitted. Remove rejected files before creating the batch.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isSubmitting}
                onClick={removeInvalid}
              >
                Remove invalid files
              </Button>
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <p>{submitError.message}</p>
              </div>
              {submitError.unauthorized && (
                <Button variant="outline" size="sm" asChild>
                  <Link
                    to="/login"
                    search={{ verified: undefined, email: undefined, error: undefined }}
                  >
                    Sign in
                  </Link>
                </Button>
              )}
            </div>
          )}
        </div>

        <aside className="space-y-8">
          <div>
            <label className="text-[12.5px] text-muted-foreground" htmlFor="batch-name">
              Batch name <span className="opacity-60">(optional)</span>
            </label>
            <Input
              id="batch-name"
              value={name}
              maxLength={MAX_BATCH_NAME_LENGTH}
              onChange={(e) => {
                rotateIdempotencyKey();
                setName(e.target.value);
              }}
              placeholder="November vendor bills"
              className="mt-2 bg-surface"
              disabled={isSubmitting}
            />
          </div>

          <div className="rounded-md border border-border bg-surface p-4 text-[13px]">
            <p className="eyebrow">Submission summary</p>
            <dl className="mt-3 space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Files to submit</dt>
                <dd className="num font-medium">
                  {readyFiles.length} / {MAX_FILES_PER_BATCH}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Total payload size</dt>
                <dd className="num">{formatBytes(totalReadyBytes)}</dd>
              </div>
            </dl>
            <p className="mt-3 border-t border-border pt-3 text-[12px] text-muted-foreground">
              One PDF equals one GATHR document. Selected PDFs are validated and prepared as
              separate document records without reading invoice contents.
            </p>
          </div>

          <div className="sticky bottom-20 lg:static">
            <Button type="submit" variant="ink" size="lg" className="w-full" disabled={!canSubmit}>
              {isSubmitting
                ? "Creating batch…"
                : overLimitCount > 0 || invalidFiles.length > 0
                  ? "Fix rejected files to continue"
                  : isValidating
                    ? "Checking PDF files…"
                    : readyFiles.length > 0
                      ? `Create batch (${readyFiles.length} PDF${readyFiles.length === 1 ? "" : "s"})`
                      : "Add PDF files to continue"}
              {!isSubmitting && <ArrowRight />}
            </Button>
          </div>
        </aside>
      </form>
    </div>
  );
}
