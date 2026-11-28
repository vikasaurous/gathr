import "@tanstack/react-start/server-only";
import JSZip from "jszip";
import {
  buildPersistedExportBaseName,
  buildSafePersistedPdfName,
  persistedDocumentsToCsv,
  persistedDocumentsToPdfReport,
  persistedDocumentsToXlsx,
  type PersistedExportDocument,
} from "@/lib/gathr/export";
import {
  isDocumentUploadStatus,
  isPersistedExportFormat,
  isPersistedExportReviewScope,
  isSafeStorageKey,
  isUuid,
  MAX_EXPORT_DOCUMENTS,
  MAX_ZIP_EXPORT_BYTES,
  MAX_ZIP_EXPORT_DOCUMENTS,
  stripControlChars,
  type BatchIngestionStatus,
  type DocumentUploadStatus,
  type PersistedExportFailure,
  type PersistedExportRequest,
  type PersistedExportReviewScope,
} from "@/lib/gathr/ingestion-types";
import {
  B2ObjectNotFoundError,
  B2StorageError,
  getB2StorageClient,
  type B2StorageClient,
} from "./b2-storage";
import { HttpError } from "./env";
import { logLifecycleEvent } from "./lifecycle-log";
import {
  assertSameOrigin,
  mapDocumentRow,
  rejectClientWorkspaceId,
  requireOwnedBatch,
  requireWorkspaceContext,
} from "./ownership";
import type { SqlClient } from "./sql";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-

export interface ExportRouteDeps {
  sql: Pick<SqlClient, "query">;
  b2?: B2StorageClient | undefined;
}

interface ExportQueriedDocument extends PersistedExportDocument {
  storageKey: string | null;
  batchStatus: BatchIngestionStatus;
}

function validatePersistedExportRequest(raw: unknown): PersistedExportRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "Invalid export request payload.", "INVALID_EXPORT_REQUEST");
  }
  const record = raw as Record<string, unknown>;

  if (!isPersistedExportFormat(record.format)) {
    throw new HttpError(400, "Unsupported export format.", "INVALID_EXPORT_FORMAT");
  }

  const scope = record.scope;
  if (scope !== "batch" && scope !== "workspace") {
    throw new HttpError(
      400,
      "Export scope must be 'batch' or 'workspace'.",
      "INVALID_EXPORT_SCOPE",
    );
  }

  let batchId: string | undefined;
  if (record.batchId !== undefined && record.batchId !== null && record.batchId !== "") {
    if (typeof record.batchId !== "string" || !isUuid(record.batchId)) {
      throw new HttpError(400, "Invalid batch identifier.", "INVALID_BATCH_ID");
    }
    batchId = record.batchId;
  }

  if (scope === "batch" && !batchId) {
    throw new HttpError(400, "batchId is required for batch exports.", "MISSING_BATCH_ID");
  }

  let documentIds: string[] | undefined;
  if (record.documentIds !== undefined) {
    if (!Array.isArray(record.documentIds)) {
      throw new HttpError(400, "documentIds must be an array of UUIDs.", "INVALID_DOCUMENT_IDS");
    }
    if (record.documentIds.length > MAX_EXPORT_DOCUMENTS) {
      throw new HttpError(
        413,
        `Cannot export more than ${MAX_EXPORT_DOCUMENTS} documents at once.`,
        "EXPORT_LIMIT_EXCEEDED",
      );
    }
    const deduped = new Set<string>();
    for (const id of record.documentIds) {
      if (typeof id !== "string" || !isUuid(id)) {
        throw new HttpError(400, "All documentIds must be valid UUIDs.", "INVALID_DOCUMENT_IDS");
      }
      deduped.add(id);
    }
    documentIds = Array.from(deduped);
  }

  let reviewScope: PersistedExportReviewScope = "all";
  if (record.reviewScope !== undefined) {
    if (!isPersistedExportReviewScope(record.reviewScope)) {
      throw new HttpError(400, "Invalid reviewScope filter.", "INVALID_REVIEW_SCOPE");
    }
    reviewScope = record.reviewScope;
  }

  let uploadStatus: DocumentUploadStatus | undefined;
  if (
    record.uploadStatus !== undefined &&
    record.uploadStatus !== null &&
    record.uploadStatus !== ""
  ) {
    if (!isDocumentUploadStatus(record.uploadStatus)) {
      throw new HttpError(400, "Invalid uploadStatus filter.", "INVALID_DOCUMENT_STATUS");
    }
    uploadStatus = record.uploadStatus;
  }

  let query: string | undefined;
  if (record.query !== undefined && record.query !== null) {
    if (typeof record.query !== "string") {
      throw new HttpError(400, "Invalid search query.", "INVALID_EXPORT_QUERY");
    }
    const cleaned = stripControlChars(record.query).trim().slice(0, 160);
    if (cleaned) query = cleaned;
  }

  return {
    format: record.format,
    scope,
    batchId,
    documentIds,
    reviewScope,
    uploadStatus,
    query,
  };
}

async function readVerifiedPdfBytes(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_ZIP_EXPORT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("PDF stream exceeded maximum allowed export size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    throw new Error("Stored PDF object is empty.");
  }
  if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && total !== expectedBytes) {
    throw new Error("Stored PDF object size does not match recorded metadata.");
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (combined.byteLength < PDF_MAGIC.length) {
    throw new Error("Stored object is too small to be a valid PDF.");
  }
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (combined[i] !== PDF_MAGIC[i]) {
      throw new Error("Stored object is not a valid PDF document.");
    }
  }

  return combined;
}

function formatSafeAttachmentHeader(filename: string): string {
  const safe = filename.replace(/[\r\n"\\]/g, "_");
  return `attachment; filename="${safe}"`;
}

/**
 * Handles POST /api/exports — read-only, workspace-scoped export for CSV, XLSX, PDF, and ZIP.
 * Never mutates document, batch, or review state, and never leaks storage keys or credentials.
 */
export async function exportWorkspaceDocuments(
  request: Request,
  rawBody: unknown,
  deps: ExportRouteDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    throw new HttpError(405, "Method not allowed. Use POST.", "METHOD_NOT_ALLOWED");
  }

  assertSameOrigin(request);
  rejectClientWorkspaceId(rawBody);

  const parsed = validatePersistedExportRequest(rawBody);
  const { workspace } = await requireWorkspaceContext(deps.sql, request);

  let scopedBatchName: string | undefined;
  if (parsed.batchId) {
    const ownedBatch = await requireOwnedBatch(deps.sql, workspace.id, parsed.batchId);
    scopedBatchName = ownedBatch.name;
  }

  const escapedSearch = parsed.query ? `%${parsed.query.replace(/[\\%_]/g, "\\$&")}%` : null;
  const documentIdsParam =
    parsed.documentIds && parsed.documentIds.length > 0 ? parsed.documentIds : null;

  if (parsed.documentIds && parsed.documentIds.length === 0) {
    throw new HttpError(404, "No documents match the selected export scope.", "EXPORT_EMPTY");
  }

  const rowLimit =
    parsed.format === "zip" ? MAX_ZIP_EXPORT_DOCUMENTS + 1 : MAX_EXPORT_DOCUMENTS + 1;

  const rows = await deps.sql.query(
    `SELECT
       d."id", d."workspace_id", d."batch_id", d."original_filename", d."mime_type",
       d."file_size_bytes", d."storage_key", d."active_attempt_id", d."lease_expires_at",
       d."upload_started_at", d."status", d."review_status", d."review_version",
       d."review_updated_at", d."page_count", d."error_message",
       d."uploaded_at", d."created_at", d."updated_at",
       b."name" AS "batch_name",
       b."status" AS "batch_status"
     FROM "documents" d
     INNER JOIN "batches" b
       ON b."id" = d."batch_id" AND b."workspace_id" = d."workspace_id"
     WHERE d."workspace_id" = $1::uuid
       AND ($2::uuid IS NULL OR d."batch_id" = $2::uuid)
       AND ($3::uuid[] IS NULL OR d."id" = ANY($3::uuid[]))
       AND ($4::text IS NULL OR d."status" = $4::text)
       AND (
         $5::text = 'all'
         OR ($5::text = 'verified_only' AND d."status" = 'uploaded' AND d."review_status" = 'verified')
         OR ($5::text = 'verified_and_review' AND d."status" = 'uploaded' AND d."review_status" IN ('verified', 'needs_review'))
         OR ($5::text = 'exclude_excluded' AND (d."review_status" IS NULL OR d."review_status" NOT IN ('duplicate', 'rejected')))
       )
       AND (
         $6::text IS NULL
         OR d."original_filename" ILIKE $6::text ESCAPE '\\'
         OR d."id"::text ILIKE $6::text ESCAPE '\\'
         OR b."name" ILIKE $6::text ESCAPE '\\'
         OR b."id"::text ILIKE $6::text ESCAPE '\\'
       )
     ORDER BY COALESCE(d."uploaded_at", d."created_at") DESC, d."created_at" DESC, d."id" DESC
     LIMIT $7::integer`,
    [
      workspace.id,
      parsed.batchId ?? null,
      documentIdsParam,
      parsed.uploadStatus ?? null,
      parsed.reviewScope ?? "all",
      escapedSearch,
      rowLimit,
    ],
  );

  if (rows.length === 0) {
    throw new HttpError(404, "No documents match the selected export scope.", "EXPORT_EMPTY");
  }

  const maxAllowed = parsed.format === "zip" ? MAX_ZIP_EXPORT_DOCUMENTS : MAX_EXPORT_DOCUMENTS;
  if (rows.length > maxAllowed) {
    throw new HttpError(
      413,
      `Export matched more than ${maxAllowed} documents. Narrow your filter or export in smaller batches.`,
      "EXPORT_LIMIT_EXCEEDED",
    );
  }

  const queriedDocs: ExportQueriedDocument[] = rows.map((row) => {
    const mapped = mapDocumentRow(row);
    return {
      id: mapped.id,
      batchId: mapped.batchId,
      batchName: String(row["batch_name"] ?? mapped.batchId),
      batchStatus: String(row["batch_status"] ?? "uploading") as BatchIngestionStatus,
      originalFilename: mapped.originalFilename,
      mimeType: mapped.mimeType,
      fileSizeBytes: mapped.fileSizeBytes,
      status: mapped.status,
      reviewStatus: mapped.reviewStatus,
      uploadedAt: mapped.uploadedAt,
      reviewUpdatedAt: mapped.reviewUpdatedAt,
      createdAt: mapped.createdAt,
      storageKey: mapped.storageKey,
    };
  });

  const exportDocs: PersistedExportDocument[] = queriedDocs.map(
    ({ storageKey: _k, batchStatus: _bs, ...rest }) => rest,
  );
  const label = scopedBatchName ?? "documents";
  const baseName = buildPersistedExportBaseName(label);

  logLifecycleEvent("info", {
    operation: "export_documents",
    outcome: "started",
    batchId: parsed.batchId,
    reason: `${parsed.format}:${exportDocs.length}`,
  });

  if (parsed.format === "csv") {
    const csv = persistedDocumentsToCsv(exportDocs);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": formatSafeAttachmentHeader(`${baseName}.csv`),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Gathr-Export-Status": "complete",
        "X-Gathr-Export-Included-Count": String(exportDocs.length),
      },
    });
  }

  if (parsed.format === "xlsx") {
    const xlsxBytes = persistedDocumentsToXlsx(exportDocs);
    return new Response(xlsxBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": formatSafeAttachmentHeader(`${baseName}.xlsx`),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Gathr-Export-Status": "complete",
        "X-Gathr-Export-Included-Count": String(exportDocs.length),
      },
    });
  }

  if (parsed.format === "pdf") {
    const pdfBytes = await persistedDocumentsToPdfReport(exportDocs, {
      title: scopedBatchName
        ? `GATHR Batch Export — ${scopedBatchName}`
        : "GATHR Document Export Report",
      scopeLabel: scopedBatchName ? `Batch: ${scopedBatchName}` : "Workspace documents",
    });
    return new Response(pdfBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": formatSafeAttachmentHeader(`${baseName}.pdf`),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Gathr-Export-Status": "complete",
        "X-Gathr-Export-Included-Count": String(exportDocs.length),
      },
    });
  }

  // ZIP export: package authorized uploaded PDFs from B2 + documents.csv + manifest.json
  const totalDeclaredBytes = queriedDocs.reduce(
    (sum, d) => sum + (d.status === "uploaded" && d.fileSizeBytes > 0 ? d.fileSizeBytes : 0),
    0,
  );
  if (totalDeclaredBytes > MAX_ZIP_EXPORT_BYTES) {
    throw new HttpError(
      413,
      "Selected documents exceed the 250 MiB ZIP archive limit. Export fewer documents at once.",
      "EXPORT_LIMIT_EXCEEDED",
    );
  }

  const b2 = deps.b2 ?? getB2StorageClient(request);
  const zip = new JSZip();
  zip.file("documents.csv", persistedDocumentsToCsv(exportDocs));

  const existingNames = new Set<string>();
  const includedFiles: string[] = ["documents.csv", "manifest.json"];
  const failures: PersistedExportFailure[] = [];
  let includedPdfCount = 0;
  let cumulativeZipBytes = 0;

  for (const doc of queriedDocs) {
    if (doc.status !== "uploaded" || !doc.storageKey || !isSafeStorageKey(doc.storageKey)) {
      failures.push({
        documentId: doc.id,
        filename: doc.originalFilename,
        code: "DOCUMENT_NOT_UPLOADED",
        reason: `Document is not in uploaded state (${doc.status}).`,
      });
      continue;
    }

    try {
      const obj = await b2.getObject({
        key: doc.storageKey,
        signal: request.signal,
      });
      const pdfBytes = await readVerifiedPdfBytes(obj.body, doc.fileSizeBytes);
      if (cumulativeZipBytes + pdfBytes.byteLength > MAX_ZIP_EXPORT_BYTES) {
        throw new HttpError(
          413,
          "Selected documents exceed the 250 MiB ZIP archive limit. Export fewer documents at once.",
          "EXPORT_LIMIT_EXCEEDED",
        );
      }
      cumulativeZipBytes += pdfBytes.byteLength;
      const safeName = buildSafePersistedPdfName(doc.originalFilename, doc.id, existingNames);
      const archivePath = `documents/${safeName}`;
      zip.file(archivePath, pdfBytes);
      includedFiles.push(archivePath);
      includedPdfCount++;
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      if (
        error instanceof B2ObjectNotFoundError ||
        (error instanceof B2StorageError && (error.status === 404 || error.s3Code === "NoSuchKey"))
      ) {
        failures.push({
          documentId: doc.id,
          filename: doc.originalFilename,
          code: "OBJECT_MISSING",
          reason: "Stored PDF object could not be found in storage.",
        });
      } else if (error instanceof B2StorageError) {
        failures.push({
          documentId: doc.id,
          filename: doc.originalFilename,
          code: "STORAGE_UNAVAILABLE",
          reason: "Could not retrieve PDF from object storage.",
        });
      } else {
        failures.push({
          documentId: doc.id,
          filename: doc.originalFilename,
          code: "OBJECT_CORRUPT",
          reason: "Stored PDF failed integrity verification.",
        });
      }
    }
  }

  if (includedPdfCount === 0) {
    logLifecycleEvent("warn", {
      operation: "export_documents",
      outcome: "failed",
      batchId: parsed.batchId,
      failureCategory: "no_documents_available",
      reason: `zip:0/${queriedDocs.length}`,
    });
    return new Response(
      JSON.stringify({
        error: "No PDF documents could be packaged into the ZIP archive.",
        code: "EXPORT_NO_DOCUMENTS_AVAILABLE",
        failures,
      }),
      {
        status: 422,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  const isPartial = failures.length > 0;
  if (isPartial) {
    includedFiles.push("ERRORS.txt");
    const errorLines = [
      `GATHR Partial Export Report (${new Date().toISOString()})`,
      `Included PDFs: ${includedPdfCount} of ${queriedDocs.length}`,
      `Failed items: ${failures.length}`,
      "",
      ...failures.map((f) => `- [${f.code}] ${f.filename} (${f.documentId}): ${f.reason}`),
    ];
    zip.file("ERRORS.txt", errorLines.join("\r\n"));
  }

  const manifest = {
    exportTimestamp: new Date().toISOString(),
    scope: parsed.scope,
    batchId: parsed.batchId ?? null,
    requestedCount: queriedDocs.length,
    includedPdfCount,
    failedCount: failures.length,
    status: isPartial ? "partial" : "complete",
    includedFiles,
    failures,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const zipBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  logLifecycleEvent(isPartial ? "warn" : "info", {
    operation: "export_documents",
    outcome: isPartial ? "partial" : "succeeded",
    batchId: parsed.batchId,
    reason: `zip:${includedPdfCount}/${queriedDocs.length}`,
  });

  const headers = new Headers({
    "Content-Type": "application/zip",
    "Content-Disposition": formatSafeAttachmentHeader(`${baseName}.zip`),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Gathr-Export-Status": isPartial ? "partial" : "complete",
    "X-Gathr-Export-Included-Count": String(includedPdfCount),
    "X-Gathr-Export-Failed-Count": String(failures.length),
  });
  if (isPartial) {
    headers.set(
      "X-Gathr-Export-Failures",
      encodeURIComponent(JSON.stringify(failures.slice(0, 25))),
    );
  }

  return new Response(zipBytes as unknown as BodyInit, {
    status: 200,
    headers,
  });
}
