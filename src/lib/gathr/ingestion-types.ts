export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_BATCH = 25;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_BATCH_NAME_LENGTH = 160;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
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

export const DOCUMENT_REVIEW_STATUSES: readonly DocumentReviewStatus[] = [
  "needs_review",
  "verified",
  "duplicate",
  "rejected",
  "skipped",
] as const;

export type EffectiveDocumentReviewState = DocumentReviewStatus | "unreviewed";

export type ReviewStatusTone = "neutral" | "warning" | "success" | "error";

export const DOCUMENT_REVIEW_STATUS_META: Record<
  EffectiveDocumentReviewState,
  { label: string; tone: ReviewStatusTone }
> = {
  unreviewed: { label: "Unreviewed", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "warning" },
  verified: { label: "Verified", tone: "success" },
  duplicate: { label: "Duplicate", tone: "error" },
  rejected: { label: "Rejected", tone: "error" },
  skipped: { label: "Skipped", tone: "neutral" },
};

export function isDocumentReviewStatus(value: unknown): value is DocumentReviewStatus {
  return (
    typeof value === "string" && (DOCUMENT_REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

export function formatReviewStatusLabel(
  status: DocumentReviewStatus | string | null | undefined,
): string {
  if (status == null || status === "" || status === "unreviewed") {
    return DOCUMENT_REVIEW_STATUS_META.unreviewed.label;
  }
  if (isDocumentReviewStatus(status)) {
    return DOCUMENT_REVIEW_STATUS_META[status].label;
  }
  return status
    .split("_")
    .filter(Boolean)
    .map((word, idx) =>
      idx === 0 ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase(),
    )
    .join(" ");
}

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export interface PersistedBatch {
  id: string;
  name: string;
  status: BatchIngestionStatus;
  finalizedAt?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedBatchSummary extends PersistedBatch {
  documentCount: number;
  pendingCount: number;
  uploadedCount: number;
  failedCount: number;
  totalSizeBytes: number;
  unreviewedCount?: number | undefined;
  needsReviewCount?: number | undefined;
  verifiedCount?: number | undefined;
  duplicateCount?: number | undefined;
  rejectedCount?: number | undefined;
  skippedCount?: number | undefined;
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
  reviewVersion?: number | undefined;
  reviewUpdatedAt?: string | null | undefined;
  pageCount: number | null;
  errorMessage: string | null;
  uploadedAt: string | null;
  createdAt: string;
  activeAttemptId?: string | null | undefined;
  leaseExpiresAt?: string | null | undefined;
}

export interface DocumentReviewEvent {
  id: string;
  documentId: string;
  fromReviewStatus: DocumentReviewStatus | null;
  toReviewStatus: DocumentReviewStatus;
  actorName: string;
  createdAt: string;
}

export interface WorkspaceDocumentListItem extends PersistedDocument {
  batchName: string;
  batchStatus: BatchIngestionStatus;
  batchFinalizedAt: string | null;
}

export interface WorkspaceDocumentReviewCounts {
  total: number;
  uploaded: number;
  unreviewed: number;
  needsReview: number;
  verified: number;
  duplicate: number;
  rejected: number;
  skipped: number;
}

export interface DocumentListResponse {
  documents: WorkspaceDocumentListItem[];
  counts: WorkspaceDocumentReviewCounts;
  filteredTotal?: number | undefined;
  hasMore?: boolean | undefined;
}

export interface ReviewDocumentRequest {
  reviewStatus: DocumentReviewStatus;
  expectedReviewStatus?: DocumentReviewStatus | null | undefined;
  expectedReviewVersion?: number | undefined;
}

export interface ReviewDocumentResponse {
  document: PersistedDocument;
  batch: PersistedBatch;
  reviewEvents: DocumentReviewEvent[];
  idempotentReplay?: boolean | undefined;
  alreadyInState?: boolean | undefined;
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
  leaseExpiresAt: string;
}

export interface HeartbeatUploadResponse {
  documentId: string;
  attemptId: string;
  leaseExpiresAt: string;
}

export interface UploadDocumentResponse {
  document: PersistedDocument;
  batch: PersistedBatch;
}

export interface CancelUploadResponse {
  document: PersistedDocument;
  batch: PersistedBatch;
  cancelled: boolean;
  serverConfirmed?: boolean | undefined;
}

export interface CreateBatchResponse {
  batch: PersistedBatch;
  documents: PersistedDocument[];
  idempotentReplay?: boolean | undefined;
}

export interface BatchListResponse {
  batches: PersistedBatchSummary[];
}

export interface BatchDetailResponse {
  batch: PersistedBatch;
  documents: PersistedDocument[];
}

export interface FinalizeBatchRequest {
  allowIncomplete?: boolean | undefined;
}

export interface FinalizeBatchResponse {
  batch: PersistedBatch;
  documents: PersistedDocument[];
  alreadyFinalized?: boolean | undefined;
}

export interface DeleteBatchResponse {
  deleted: boolean;
  batchId: string;
  cleanupJobsQueued: number;
}

export interface DocumentDetailResponse {
  document: PersistedDocument;
  batch: PersistedBatch;
  reviewEvents?: DocumentReviewEvent[] | undefined;
}

export interface DeleteDocumentResponse {
  deleted: boolean;
  documentId: string;
  batchId: string;
  batch: PersistedBatch;
  cleanupJobsQueued: number;
}

export interface BatchValidationIssue {
  index?: number | undefined;
  field?: string | undefined;
  message: string;
}

export class BatchCreateValidationError extends Error {
  readonly issues: BatchValidationIssue[];

  constructor(message: string, issues: BatchValidationIssue[] = [{ message }]) {
    super(message);
    this.name = "BatchCreateValidationError";
    this.issues = issues;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;
const PATH_TRAVERSAL_SEGMENT_REGEX = /(^|[\\/])\.\.([\\/]|$)/;

export function isUuid(value: string): boolean {
  // Strict on purpose: Postgres rejects whitespace-padded uuids (22P02), so a padded
  // value must fail validation here (400) instead of reaching SQL (500).
  return UUID_REGEX.test(value);
}

export function validateIdempotencyKey(rawKey: string | null | undefined): string | undefined {
  if (rawKey == null) return undefined;
  const trimmed = rawKey.trim();
  if (!trimmed || !IDEMPOTENCY_KEY_REGEX.test(trimmed)) {
    throw new BatchCreateValidationError(
      `Idempotency-Key must be 1–${MAX_IDEMPOTENCY_KEY_LENGTH} URL-safe ASCII characters.`,
      [{ field: "Idempotency-Key", message: "Invalid Idempotency-Key header." }],
    );
  }
  return trimmed;
}

export function normalizeMimeType(mimeType: string | null | undefined): string {
  if (!mimeType) return "";
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isPdfMimeType(mimeType: string | null | undefined): boolean {
  return normalizeMimeType(mimeType) === PDF_MIME_TYPE;
}

function isInvisibleOrBidiControlCode(code: number): boolean {
  return (
    code < 32 ||
    code === 127 ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

export function stripControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (!isInvisibleOrBidiControlCode(code)) {
      out += value[i];
    }
  }
  return out;
}

function truncatePreservingPdfExt(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") && maxLength > 4) {
    const ext = name.slice(-4);
    const stem = name.slice(0, maxLength - 4).trimEnd();
    return stem ? `${stem}${ext}` : name.slice(0, maxLength);
  }
  return name.slice(0, maxLength);
}

export function sanitizeOriginalFilename(rawName: string): string {
  const withoutControls = stripControlChars(rawName).trim();
  const segments = withoutControls.split(/[/\\]+/).filter(Boolean);
  const baseName = (segments[segments.length - 1] ?? "").trim();
  const cleaned = baseName
    .replace(/[:*?"<>|;]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  return truncatePreservingPdfExt(cleaned, MAX_FILENAME_LENGTH);
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

/**
 * Ensures every filename in a batch remains distinguishable without dropping its
 * .pdf extension or exceeding 255 characters.
 */
export function disambiguateBatchFilenames(filenames: string[]): string[] {
  const used = new Set<string>();
  return filenames.map((raw) => {
    const clean = sanitizeOriginalFilename(raw) || "document.pdf";
    if (!used.has(clean.toLowerCase())) {
      used.add(clean.toLowerCase());
      return clean;
    }

    const hasExt = clean.toLowerCase().endsWith(".pdf") && clean.length > 4;
    const ext = hasExt ? clean.slice(-4) : "";
    const stem = hasExt ? clean.slice(0, -4) : clean;

    let n = 2;
    for (;;) {
      const suffix = ` (${n})`;
      const maxStemLen = MAX_FILENAME_LENGTH - ext.length - suffix.length;
      const truncatedStem = stem.slice(0, Math.max(1, maxStemLen)).trimEnd() || "doc";
      const candidate = `${truncatedStem}${suffix}${ext}`;
      if (!used.has(candidate.toLowerCase())) {
        used.add(candidate.toLowerCase());
        return candidate;
      }
      n++;
    }
  });
}

/**
 * Fast synchronous client validation for metadata (extension, MIME, size, filename).
 * Magic-byte signature validation runs separately via `hasValidPdfHeader`.
 */
export function checkPdfFileMetadata(file: {
  name: string;
  type?: string | undefined;
  size: number;
}): string | undefined {
  if (typeof file.name !== "string" || !file.name.trim()) {
    return "File must have a valid filename.";
  }
  const cleanName = sanitizeOriginalFilename(file.name);
  if (!cleanName || !hasPdfExtension(cleanName)) {
    return "Only PDF (.pdf) files are supported.";
  }
  const normalizedMime = normalizeMimeType(file.type);
  if (normalizedMime && normalizedMime !== PDF_MIME_TYPE) {
    return "Only application/pdf files are supported.";
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "File is empty (0 bytes).";
  }
  if (file.size > MAX_FILE_BYTES) {
    return "File exceeds the 50 MiB limit.";
  }
  return undefined;
}

async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file bytes."));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file bytes."));
    reader.readAsArrayBuffer(blob);
  });
}

export async function hasValidPdfHeader(file: Blob): Promise<boolean> {
  if (file.size < PDF_SIGNATURE_BYTES.length) return false;
  const buffer = await readBlobBytes(file.slice(0, PDF_SIGNATURE_BYTES.length));
  return hasPdfSignature(new Uint8Array(buffer));
}

export function sanitizeDownloadFilename(filename: string): string {
  const cleaned = sanitizeOriginalFilename(filename).replace(/;/g, "_");
  if (!cleaned) return "document.pdf";
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  return truncatePreservingPdfExt(withExt, MAX_FILENAME_LENGTH);
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

const STORAGE_KEY_REGEX =
  /^gathr\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.pdf$/i;

export function isSafeStorageKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) return false;
  if (key.includes("..") || key.includes("\\") || key.includes("\0")) return false;
  return STORAGE_KEY_REGEX.test(key);
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
    throw new BatchCreateValidationError("Invalid request body. Expected a JSON object.");
  }

  const allowedKeys = new Set(["name", "files"]);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      throw new BatchCreateValidationError(`Unexpected field in request payload: "${key}".`, [
        { field: key, message: `Unexpected field "${key}".` },
      ]);
    }
  }

  const record = data as { name?: unknown; files?: unknown };

  let name: string | undefined = undefined;
  if (record.name !== undefined) {
    if (typeof record.name !== "string") {
      throw new BatchCreateValidationError("Batch name must be a string.", [
        { field: "name", message: "Batch name must be a string." },
      ]);
    }
    const cleanBatchName = stripControlChars(record.name).trim();
    if (cleanBatchName.length > MAX_BATCH_NAME_LENGTH) {
      throw new BatchCreateValidationError(
        `Batch name must be ${MAX_BATCH_NAME_LENGTH} characters or fewer.`,
        [{ field: "name", message: `Batch name exceeds ${MAX_BATCH_NAME_LENGTH} characters.` }],
      );
    }
    name = cleanBatchName || undefined;
  }

  if (!Array.isArray(record.files)) {
    throw new BatchCreateValidationError("Files must be an array.", [
      { field: "files", message: "Files must be an array." },
    ]);
  }

  if (record.files.length === 0) {
    throw new BatchCreateValidationError("At least one PDF file is required.", [
      { field: "files", message: "At least one PDF file is required." },
    ]);
  }

  if (record.files.length > MAX_FILES_PER_BATCH) {
    throw new BatchCreateValidationError(
      `A batch cannot contain more than ${MAX_FILES_PER_BATCH} files.`,
      [{ field: "files", message: `Maximum ${MAX_FILES_PER_BATCH} files allowed per batch.` }],
    );
  }

  const fileKeys = new Set(["filename", "mimeType", "sizeBytes"]);
  const files: CreateBatchRequestFile[] = [];

  for (let i = 0; i < record.files.length; i++) {
    const file = record.files[i];
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new BatchCreateValidationError(`File at index ${i} must be an object.`, [
        { index: i, message: "File entry must be an object." },
      ]);
    }

    for (const key of Object.keys(file)) {
      if (!fileKeys.has(key)) {
        throw new BatchCreateValidationError(`Unexpected field in file at index ${i}: "${key}".`, [
          { index: i, field: key, message: `Unexpected field "${key}".` },
        ]);
      }
    }

    const fileRec = file as { filename?: unknown; mimeType?: unknown; sizeBytes?: unknown };
    if (typeof fileRec.filename !== "string" || !fileRec.filename.trim()) {
      throw new BatchCreateValidationError(`File at index ${i} must have a valid filename.`, [
        { index: i, field: "filename", message: "Filename is required." },
      ]);
    }

    if (fileRec.filename.includes("\0") || PATH_TRAVERSAL_SEGMENT_REGEX.test(fileRec.filename)) {
      throw new BatchCreateValidationError(
        `File at index ${i} contains an invalid path sequence.`,
        [{ index: i, field: "filename", message: "Invalid path sequence in filename." }],
      );
    }

    const cleanName = sanitizeOriginalFilename(fileRec.filename);
    if (!cleanName || !hasPdfExtension(cleanName)) {
      throw new BatchCreateValidationError(
        `File "${cleanName || "unnamed"}" is not a valid PDF file (.pdf).`,
        [{ index: i, field: "filename", message: "Only valid .pdf filenames are allowed." }],
      );
    }

    let mimeType: string | undefined = undefined;
    if (fileRec.mimeType !== undefined) {
      if (typeof fileRec.mimeType !== "string") {
        throw new BatchCreateValidationError(`File at index ${i} mimeType must be a string.`, [
          { index: i, field: "mimeType", message: "mimeType must be a string." },
        ]);
      }
      const norm = normalizeMimeType(fileRec.mimeType);
      if (norm && norm !== PDF_MIME_TYPE) {
        throw new BatchCreateValidationError("Only application/pdf files are supported.", [
          { index: i, field: "mimeType", message: "Only application/pdf files are supported." },
        ]);
      }
      mimeType = norm || undefined;
    }

    if (
      typeof fileRec.sizeBytes !== "number" ||
      !Number.isSafeInteger(fileRec.sizeBytes) ||
      fileRec.sizeBytes <= 0
    ) {
      throw new BatchCreateValidationError(`File "${cleanName}" has an invalid size.`, [
        { index: i, field: "sizeBytes", message: "File size must be a positive integer." },
      ]);
    }

    if (fileRec.sizeBytes > MAX_FILE_BYTES) {
      throw new BatchCreateValidationError(`File "${cleanName}" exceeds the 50 MiB limit.`, [
        { index: i, field: "sizeBytes", message: "File exceeds the 50 MiB limit." },
      ]);
    }

    files.push({
      filename: cleanName,
      mimeType,
      sizeBytes: fileRec.sizeBytes,
    });
  }

  return { name, files };
}

export async function computeCreateBatchRequestHash(payload: CreateBatchRequest): Promise<string> {
  const canonical = JSON.stringify({
    name: payload.name ? stripControlChars(payload.name).trim() : "",
    files: payload.files.map((f) => ({
      filename: sanitizeOriginalFilename(f.filename),
      mimeType: normalizeMimeType(f.mimeType),
      sizeBytes: f.sizeBytes,
    })),
  });
  const encoded = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function deriveBatchName(rawName: string | undefined, filenames: string[]): string {
  const trimmed = stripControlChars(rawName ?? "").trim();
  if (trimmed) return trimmed.slice(0, MAX_BATCH_NAME_LENGTH);
  if (filenames.length === 1) {
    const first = sanitizeOriginalFilename(filenames[0] ?? "");
    const base = first.replace(/\.pdf$/i, "").trim();
    if (base) return base.slice(0, MAX_BATCH_NAME_LENGTH);
  }
  const dateLabel = new Date().toLocaleDateString("en-GB", { timeZone: "UTC" });
  return `${filenames.length} PDF${filenames.length === 1 ? "" : "s"} · ${dateLabel}`;
}

export const ALLOWED_BATCH_STATUS_TRANSITIONS: Record<
  BatchIngestionStatus,
  readonly BatchIngestionStatus[]
> = {
  uploading: ["uploading", "uploaded", "partial", "failed"],
  uploaded: ["uploaded"],
  partial: ["partial", "uploading", "uploaded", "failed"],
  failed: ["failed", "uploading", "partial", "uploaded"],
};

export const ALLOWED_DOCUMENT_UPLOAD_TRANSITIONS: Record<
  DocumentUploadStatus,
  readonly DocumentUploadStatus[]
> = {
  pending_upload: ["uploading", "failed"],
  uploading: ["uploading", "uploaded", "failed"],
  uploaded: [],
  failed: ["uploading"],
};

export function isValidBatchTransition(
  from: BatchIngestionStatus,
  to: BatchIngestionStatus,
  isFinalized: boolean,
): boolean {
  if (isFinalized) {
    return to !== "uploading" && from === to;
  }
  return ALLOWED_BATCH_STATUS_TRANSITIONS[from].includes(to);
}

export function isValidDocumentTransition(
  from: DocumentUploadStatus,
  to: DocumentUploadStatus,
): boolean {
  return ALLOWED_DOCUMENT_UPLOAD_TRANSITIONS[from].includes(to);
}

export function computeBatchFinalStatus(
  totalCount: number,
  uploadedCount: number,
): BatchIngestionStatus {
  if (totalCount > 0 && uploadedCount === totalCount) return "uploaded";
  if (uploadedCount > 0) return "partial";
  return "failed";
}

/**
 * Canonical business review state transitions for uploaded documents.
 * Once a decision (`verified`, `duplicate`, `rejected`, `skipped`) is recorded,
 * changing to a different decision requires reopening to `needs_review` first.
 * Same-state submissions are handled idempotently on the server.
 */
export const ALLOWED_DOCUMENT_REVIEW_TRANSITIONS: Record<
  EffectiveDocumentReviewState,
  readonly DocumentReviewStatus[]
> = {
  unreviewed: ["needs_review", "verified", "duplicate", "rejected", "skipped"],
  needs_review: ["verified", "duplicate", "rejected", "skipped"],
  verified: ["needs_review"],
  duplicate: ["needs_review"],
  rejected: ["needs_review"],
  skipped: ["needs_review"],
};

export function isValidDocumentReviewTransition(
  from: DocumentReviewStatus | null,
  to: DocumentReviewStatus,
): boolean {
  const key: EffectiveDocumentReviewState = from ?? "unreviewed";
  return ALLOWED_DOCUMENT_REVIEW_TRANSITIONS[key].includes(to);
}

export function getAvailableReviewActions(
  uploadStatus: DocumentUploadStatus,
  reviewStatus: DocumentReviewStatus | null,
): readonly DocumentReviewStatus[] {
  if (uploadStatus !== "uploaded") return [];
  const key: EffectiveDocumentReviewState = reviewStatus ?? "unreviewed";
  return ALLOWED_DOCUMENT_REVIEW_TRANSITIONS[key];
}

export class ReviewValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "INVALID_REVIEW_REQUEST") {
    super(message);
    this.name = "ReviewValidationError";
    this.code = code;
  }
}

export function validateReviewDocumentPayload(data: unknown): ReviewDocumentRequest {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ReviewValidationError("Invalid request body. Expected a JSON object.");
  }

  const allowedKeys = new Set(["reviewStatus", "expectedReviewStatus", "expectedReviewVersion"]);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      throw new ReviewValidationError(
        `Unexpected field in review request: "${key}".`,
        "UNEXPECTED_FIELD",
      );
    }
  }

  const record = data as {
    reviewStatus?: unknown;
    expectedReviewStatus?: unknown;
    expectedReviewVersion?: unknown;
  };

  if (!isDocumentReviewStatus(record.reviewStatus)) {
    throw new ReviewValidationError(
      "reviewStatus must be one of: needs_review, verified, duplicate, rejected, skipped.",
      "INVALID_REVIEW_STATUS",
    );
  }

  let expectedReviewStatus: DocumentReviewStatus | null | undefined = undefined;
  if (record.expectedReviewStatus !== undefined) {
    if (
      record.expectedReviewStatus !== null &&
      !isDocumentReviewStatus(record.expectedReviewStatus)
    ) {
      throw new ReviewValidationError(
        "expectedReviewStatus must be null or a valid review status.",
        "INVALID_REVIEW_EXPECTATION",
      );
    }
    expectedReviewStatus = record.expectedReviewStatus;
  }

  let expectedReviewVersion: number | undefined = undefined;
  if (record.expectedReviewVersion !== undefined) {
    if (
      typeof record.expectedReviewVersion !== "number" ||
      !Number.isSafeInteger(record.expectedReviewVersion) ||
      record.expectedReviewVersion < 0
    ) {
      throw new ReviewValidationError(
        "expectedReviewVersion must be a non-negative integer.",
        "INVALID_REVIEW_EXPECTATION",
      );
    }
    expectedReviewVersion = record.expectedReviewVersion;
  }

  return {
    reviewStatus: record.reviewStatus,
    ...(expectedReviewStatus !== undefined ? { expectedReviewStatus } : {}),
    ...(expectedReviewVersion !== undefined ? { expectedReviewVersion } : {}),
  };
}

export async function computeReviewDocumentRequestHash(
  payload: ReviewDocumentRequest,
): Promise<string> {
  const canonical = JSON.stringify({
    reviewStatus: payload.reviewStatus,
    expectedReviewStatus:
      payload.expectedReviewStatus === undefined ? "__omitted__" : payload.expectedReviewStatus,
    expectedReviewVersion:
      payload.expectedReviewVersion === undefined ? "__omitted__" : payload.expectedReviewVersion,
  });
  const encoded = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const PERSISTED_EXPORT_FORMATS = ["csv", "xlsx", "pdf", "zip"] as const;
export type PersistedExportFormat = (typeof PERSISTED_EXPORT_FORMATS)[number];

export const PERSISTED_EXPORT_REVIEW_SCOPES = [
  "all",
  "verified_only",
  "verified_and_review",
  "exclude_excluded",
] as const;
export type PersistedExportReviewScope = (typeof PERSISTED_EXPORT_REVIEW_SCOPES)[number];

export type PersistedExportScope = "batch" | "workspace";

export const MAX_EXPORT_DOCUMENTS = 5000;
export const MAX_ZIP_EXPORT_DOCUMENTS = 250;
export const MAX_ZIP_EXPORT_BYTES = 250 * 1024 * 1024;

export interface PersistedExportRequest {
  format: PersistedExportFormat;
  scope: PersistedExportScope;
  batchId?: string | undefined;
  documentIds?: string[] | undefined;
  reviewScope?: PersistedExportReviewScope | undefined;
  uploadStatus?: DocumentUploadStatus | undefined;
  query?: string | undefined;
}

export interface PersistedExportFailure {
  documentId: string;
  filename: string;
  code: string;
  reason: string;
}

export function isDocumentUploadStatus(value: unknown): value is DocumentUploadStatus {
  return (
    typeof value === "string" &&
    (value === "pending_upload" ||
      value === "uploading" ||
      value === "uploaded" ||
      value === "failed")
  );
}

export function isPersistedExportFormat(value: unknown): value is PersistedExportFormat {
  return (
    typeof value === "string" && (PERSISTED_EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

export function isPersistedExportReviewScope(value: unknown): value is PersistedExportReviewScope {
  return (
    typeof value === "string" &&
    (PERSISTED_EXPORT_REVIEW_SCOPES as readonly string[]).includes(value)
  );
}
