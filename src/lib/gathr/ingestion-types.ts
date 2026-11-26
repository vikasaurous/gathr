export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_BATCH = 25;
export const PDF_MIME_TYPE = "application/pdf";
export const PDF_SIGNATURE_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

export type BatchIngestionStatus = "uploading" | "uploaded" | "partial" | "failed";

/**
 * Technical upload lifecycle state.
 * NEVER conflate with business review/approval state.
 * "uploaded" means the file is stored; it does NOT mean approved.
 * "failed" means the upload failed; it does NOT mean business rejected.
 */
export type DocumentUploadStatus = "pending_upload" | "uploading" | "uploaded" | "failed";

/**
 * Business review/approval state.
 * Only set after status = "uploaded". NULL means not yet reviewed.
 * - needs_review: awaiting human review
 * - verified:     reviewer confirmed the document is valid
 * - duplicate:    reviewer flagged as a duplicate of another document
 * - rejected:     reviewer rejected (invalid document, wrong file, etc.)
 * - skipped:      excluded from this batch's output intentionally
 */
export type DocumentReviewStatus =
  "needs_review" | "verified" | "duplicate" | "rejected" | "skipped";

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export interface PersistedBatch {
  id: string;
  name: string;
  status: BatchIngestionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedBatchSummary extends PersistedBatch {
  documentCount: number;
  uploadedCount: number;
  failedCount: number;
  totalSizeBytes: number;
}

export interface PersistedDocument {
  id: string;
  batchId: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  /** Technical upload lifecycle state — never conflate with review_status. */
  status: DocumentUploadStatus;
  /** Business review/approval state — null until document is uploaded. */
  reviewStatus: DocumentReviewStatus | null;
  pageCount: number | null;
  errorMessage: string | null;
  uploadedAt: string | null;
  createdAt: string;
  activeAttemptId?: string | null | undefined;
  leaseExpiresAt?: string | null | undefined;
}

export interface CreateBatchRequestFile {
  filename: string;
  mimeType?: string | undefined;
  sizeBytes: number;
}

export interface CreateBatchRequest {
  name?: string | undefined;
  files: CreateBatchRequestFile[];
}

export interface ClaimUploadResponse {
  documentId: string;
  attemptId: string;
  storageKey: string;
  leaseExpiresAt: string;
}

export interface CreateBatchResponse {
  batch: PersistedBatch;
  documents: PersistedDocument[];
}

export interface FinalizeBatchResponse {
  batch: PersistedBatch;
  documents: PersistedDocument[];
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  // Strict on purpose: Postgres rejects whitespace-padded uuids (22P02), so a padded
  // value must fail validation here (400) instead of reaching SQL (500).
  return UUID_REGEX.test(value);
}

export function normalizeMimeType(mimeType: string | null | undefined): string {
  if (!mimeType) return "";
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isPdfMimeType(mimeType: string | null | undefined): boolean {
  return normalizeMimeType(mimeType) === PDF_MIME_TYPE;
}

function stripControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 32 && code !== 127) {
      out += value[i];
    }
  }
  return out;
}

export function sanitizeOriginalFilename(rawName: string): string {
  const withoutControls = stripControlChars(rawName).trim();
  const segments = withoutControls.split(/[/\\]+/).filter(Boolean);
  const baseName = (segments[segments.length - 1] ?? "").trim();
  const cleaned = baseName.replace(/[:*?"<>|]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  return cleaned.slice(0, 255);
}

export function hasPdfExtension(filename: string): boolean {
  const clean = sanitizeOriginalFilename(filename);
  if (!clean) return false;
  const lower = clean.toLowerCase();
  return lower.endsWith(".pdf") && lower.length > 4;
}

export function hasPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_SIGNATURE_BYTES.length) return false;
  for (let i = 0; i < PDF_SIGNATURE_BYTES.length; i++) {
    if (bytes[i] !== PDF_SIGNATURE_BYTES[i]) return false;
  }
  return true;
}

export function sanitizeDownloadFilename(filename: string): string {
  const cleaned = sanitizeOriginalFilename(filename).replace(/;/g, "_");
  if (!cleaned) return "document.pdf";
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  return withExt.slice(0, 255);
}

export function toAsciiHeaderFilename(filename: string): string {
  const safe = sanitizeDownloadFilename(filename);
  let ascii = "";
  for (let i = 0; i < safe.length; i++) {
    const ch = safe[i] ?? "";
    const code = safe.charCodeAt(i);
    if (code >= 32 && code <= 126 && ch !== '"' && ch !== "\\" && ch !== ";") {
      ascii += ch;
    } else {
      ascii += "_";
    }
  }
  const trimmed = ascii.trim();
  if (!trimmed || trimmed === ".pdf") return "document.pdf";
  return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`;
}

export function buildStorageKey(ids: {
  workspaceId: string;
  batchId: string;
  documentId: string;
  attemptId?: string | undefined;
}): string {
  const { workspaceId, batchId, documentId, attemptId } = ids;
  if (!isUuid(workspaceId) || !isUuid(batchId) || !isUuid(documentId)) {
    throw new Error("Storage key components must be valid UUIDs.");
  }
  if (attemptId !== undefined) {
    if (!isUuid(attemptId)) {
      throw new Error("Storage key attemptId must be a valid UUID.");
    }
    return `gathr/${workspaceId}/${batchId}/${documentId}/${attemptId}.pdf`;
  }
  return `gathr/${workspaceId}/${batchId}/${documentId}.pdf`;
}

export function validateCreateBatchPayload(data: unknown): CreateBatchRequest {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid request body. Expected a JSON object.");
  }

  const allowedKeys = new Set(["name", "files"]);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected field in request payload: "${key}".`);
    }
  }

  const record = data as { name?: unknown; files?: unknown };

  let name: string | undefined = undefined;
  if (record.name !== undefined) {
    if (typeof record.name !== "string") {
      throw new Error("Batch name must be a string.");
    }
    name = record.name;
  }

  if (!Array.isArray(record.files)) {
    throw new Error("Files must be an array.");
  }

  if (record.files.length === 0) {
    throw new Error("At least one PDF file is required.");
  }

  if (record.files.length > MAX_FILES_PER_BATCH) {
    throw new Error(`A batch cannot contain more than ${MAX_FILES_PER_BATCH} files.`);
  }

  const fileKeys = new Set(["filename", "mimeType", "sizeBytes"]);
  const files: CreateBatchRequestFile[] = [];

  for (let i = 0; i < record.files.length; i++) {
    const file = record.files[i];
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error(`File at index ${i} must be an object.`);
    }

    for (const key of Object.keys(file)) {
      if (!fileKeys.has(key)) {
        throw new Error(`Unexpected field in file at index ${i}: "${key}".`);
      }
    }

    const fileRec = file as { filename?: unknown; mimeType?: unknown; sizeBytes?: unknown };
    if (typeof fileRec.filename !== "string" || !fileRec.filename.trim()) {
      throw new Error(`File at index ${i} must have a valid filename.`);
    }

    const cleanName = sanitizeOriginalFilename(fileRec.filename);
    if (!cleanName || !hasPdfExtension(cleanName)) {
      throw new Error(`File "${fileRec.filename}" is not a valid PDF file (.pdf).`);
    }

    let mimeType: string | undefined = undefined;
    if (fileRec.mimeType !== undefined) {
      if (typeof fileRec.mimeType !== "string") {
        throw new Error(`File at index ${i} mimeType must be a string.`);
      }
      const norm = normalizeMimeType(fileRec.mimeType);
      if (norm && norm !== PDF_MIME_TYPE) {
        throw new Error("Only application/pdf files are supported.");
      }
      mimeType = fileRec.mimeType;
    }

    if (
      typeof fileRec.sizeBytes !== "number" ||
      !Number.isSafeInteger(fileRec.sizeBytes) ||
      fileRec.sizeBytes <= 0
    ) {
      throw new Error(`File "${fileRec.filename}" has an invalid size.`);
    }

    if (fileRec.sizeBytes > MAX_FILE_BYTES) {
      throw new Error(`File "${fileRec.filename}" exceeds the 50 MB limit.`);
    }

    files.push({
      filename: cleanName,
      mimeType,
      sizeBytes: fileRec.sizeBytes,
    });
  }

  return { name, files };
}

export function deriveBatchName(rawName: string | undefined, filenames: string[]): string {
  const trimmed = stripControlChars(rawName ?? "").trim();
  if (trimmed) return trimmed.slice(0, 160);
  if (filenames.length === 1) {
    const first = sanitizeOriginalFilename(filenames[0] ?? "");
    const base = first.replace(/\.pdf$/i, "").trim();
    if (base) return base.slice(0, 160);
  }
  const dateLabel = new Date().toLocaleDateString("en-GB", { timeZone: "UTC" });
  return `${filenames.length} PDF${filenames.length === 1 ? "" : "s"} · ${dateLabel}`;
}

export function computeBatchFinalStatus(
  totalCount: number,
  uploadedCount: number,
): BatchIngestionStatus {
  if (totalCount > 0 && uploadedCount === totalCount) return "uploaded";
  if (uploadedCount > 0) return "partial";
  return "failed";
}
