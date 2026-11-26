import { describe, expect, it } from "vitest";
import {
  BatchCreateValidationError,
  checkPdfFileMetadata,
  computeCreateBatchRequestHash,
  deriveBatchName,
  disambiguateBatchFilenames,
  hasPdfExtension,
  hasPdfSignature,
  hasValidPdfHeader,
  MAX_BATCH_NAME_LENGTH,
  MAX_FILE_BYTES,
  MAX_FILES_PER_BATCH,
  sanitizeDownloadFilename,
  sanitizeOriginalFilename,
  toAsciiHeaderFilename,
  validateCreateBatchPayload,
  validateIdempotencyKey,
} from "@/lib/gathr/ingestion-types";

describe("Phase 3 filename sanitization and collision disambiguation", () => {
  it("strips path segments, control characters, and Unicode bidi spoofing characters", () => {
    expect(sanitizeOriginalFilename("C:\\fakepath\\Nov Invoice.pdf")).toBe("Nov Invoice.pdf");
    expect(sanitizeOriginalFilename("folder/sub/bill\x00\x07.pdf")).toBe("bill.pdf");
    expect(sanitizeOriginalFilename("invoice\u202Efdp.pdf")).toBe("invoicefdp.pdf");
    expect(sanitizeOriginalFilename('semi;colon"quote.pdf')).toBe("semi_colon_quote.pdf");
    expect(sanitizeOriginalFilename(".")).toBe("");
    expect(sanitizeOriginalFilename("..")).toBe("");
    expect(sanitizeOriginalFilename("   ")).toBe("");
  });

  it("preserves the .pdf extension when truncating filenames longer than 255 characters", () => {
    const longName = `${"a".repeat(260)}.pdf`;
    const sanitized = sanitizeOriginalFilename(longName);
    expect(sanitized.length).toBe(255);
    expect(sanitized.endsWith(".pdf")).toBe(true);
    expect(hasPdfExtension(sanitized)).toBe(true);
  });

  it("sanitizes HTTP Content-Disposition header filenames", () => {
    expect(toAsciiHeaderFilename('dir\\in"voice;test.pdf')).toBe("in_voice_test.pdf");
    expect(sanitizeDownloadFilename("../..")).toBe("document.pdf");
  });

  it("disambiguates colliding filenames within a batch without losing distinguishability", () => {
    expect(
      disambiguateBatchFilenames(["invoice.pdf", "Invoice.pdf", "invoice (2).pdf", "other.pdf"]),
    ).toEqual(["invoice.pdf", "Invoice (2).pdf", "invoice (2) (2).pdf", "other.pdf"]);

    const maxCollision = `${"x".repeat(251)}.pdf`;
    const disambiguated = disambiguateBatchFilenames([maxCollision, maxCollision]);
    expect(disambiguated[0]).toBe(maxCollision);
    expect(disambiguated[1]!.length).toBeLessThanOrEqual(255);
    expect(disambiguated[1]!.endsWith(".pdf")).toBe(true);
    expect(disambiguated[1]).not.toBe(disambiguated[0]);
  });
});

describe("Phase 3 client PDF checks and signature verification", () => {
  it("checks PDF magic bytes synchronously and via File/Blob slice", async () => {
    expect(hasPdfSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe(true);
    expect(hasPdfSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
    expect(hasPdfSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(false);

    const validBlob = new Blob(["%PDF-1.7\n..."], { type: "application/pdf" });
    const fakePdf = new Blob(["NOT A PDF"], { type: "application/pdf" });
    expect(await hasValidPdfHeader(validBlob)).toBe(true);
    expect(await hasValidPdfHeader(fakePdf)).toBe(false);
  });

  it("validates file extension, MIME type, zero-byte, and 50 MiB limit", () => {
    expect(
      checkPdfFileMetadata({ name: "inv.pdf", type: "application/pdf", size: 1024 }),
    ).toBeUndefined();
    // Some OS setups omit MIME type on .pdf files; magic-byte check handles content
    expect(checkPdfFileMetadata({ name: "inv.pdf", type: "", size: 1024 })).toBeUndefined();
    expect(
      checkPdfFileMetadata({ name: "exact50.pdf", type: "application/pdf", size: MAX_FILE_BYTES }),
    ).toBeUndefined();

    expect(checkPdfFileMetadata({ name: "inv.txt", type: "text/plain", size: 100 })).toMatch(
      /Only PDF/,
    );
    expect(checkPdfFileMetadata({ name: "inv.pdf", type: "text/html", size: 100 })).toMatch(
      /application\/pdf/,
    );
    expect(checkPdfFileMetadata({ name: "empty.pdf", type: "application/pdf", size: 0 })).toMatch(
      /empty/i,
    );
    expect(
      checkPdfFileMetadata({
        name: "huge.pdf",
        type: "application/pdf",
        size: MAX_FILE_BYTES + 1,
      }),
    ).toMatch(/50 MiB/);
  });
});

describe("Phase 3 server payload, idempotency key, and hash validation", () => {
  it("accepts a valid single or 25-file batch payload", () => {
    const single = validateCreateBatchPayload({
      name: "  November bills ",
      files: [{ filename: "inv-1.pdf", mimeType: "application/pdf", sizeBytes: 1024 }],
    });
    expect(single).toEqual({
      name: "November bills",
      files: [{ filename: "inv-1.pdf", mimeType: "application/pdf", sizeBytes: 1024 }],
    });

    const maxFiles = Array.from({ length: MAX_FILES_PER_BATCH }, (_, i) => ({
      filename: `doc-${i + 1}.pdf`,
      sizeBytes: MAX_FILE_BYTES,
    }));
    expect(validateCreateBatchPayload({ files: maxFiles }).files).toHaveLength(MAX_FILES_PER_BATCH);
  });

  it("rejects malformed payloads, path traversal, over-limit counts, and unexpected fields", () => {
    const badInputs: unknown[] = [
      null,
      [],
      { files: [] },
      {
        workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        files: [{ filename: "a.pdf", sizeBytes: 10 }],
      },
      {
        name: "x".repeat(MAX_BATCH_NAME_LENGTH + 1),
        files: [{ filename: "a.pdf", sizeBytes: 10 }],
      },
      {
        files: Array.from({ length: MAX_FILES_PER_BATCH + 1 }, (_, i) => ({
          filename: `doc-${i}.pdf`,
          sizeBytes: 10,
        })),
      },
      { files: [{ filename: "../../secret.pdf", sizeBytes: 10 }] },
      { files: [{ filename: "bad\x00.pdf", sizeBytes: 10 }] },
      { files: [{ filename: ".pdf", sizeBytes: 10 }] },
      { files: [{ filename: "a.txt", sizeBytes: 10 }] },
      { files: [{ filename: "a.pdf", mimeType: "text/plain", sizeBytes: 10 }] },
      { files: [{ filename: "a.pdf", sizeBytes: 0 }] },
      { files: [{ filename: "a.pdf", sizeBytes: -1 }] },
      { files: [{ filename: "a.pdf", sizeBytes: 12.5 }] },
      { files: [{ filename: "a.pdf", sizeBytes: MAX_FILE_BYTES + 1 }] },
      { files: [{ filename: "a.pdf", sizeBytes: 10, storageKey: "gathr/evil" }] },
    ];

    for (const input of badInputs) {
      expect(() => validateCreateBatchPayload(input)).toThrow(BatchCreateValidationError);
    }
  });

  it("validates Idempotency-Key format strictly", () => {
    expect(validateIdempotencyKey(undefined)).toBeUndefined();
    expect(validateIdempotencyKey("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    for (const bad of ["", "   ", "has spaces", "has\nnewline", "x".repeat(129)]) {
      expect(() => validateIdempotencyKey(bad)).toThrow(BatchCreateValidationError);
    }
  });

  it("computes deterministic canonical request hashes and sensible default batch names", async () => {
    const h1 = await computeCreateBatchRequestHash({
      name: "  October  ",
      files: [{ filename: "a.pdf", mimeType: "APPLICATION/PDF", sizeBytes: 100 }],
    });
    const h2 = await computeCreateBatchRequestHash({
      name: "October",
      files: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 100 }],
    });
    const h3 = await computeCreateBatchRequestHash({
      name: "October",
      files: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 101 }],
    });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);

    expect(deriveBatchName(undefined, ["vendor-bill.pdf"])).toBe("vendor-bill");
    expect(deriveBatchName(undefined, ["a.pdf", "b.pdf"])).toMatch(/^2 PDFs · /);
  });
});
