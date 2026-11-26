// @vitest-environment node
/**
 * Phase 4 — Backblaze B2 S3-compatible configuration, endpoint/region validation,
 * AWS SigV4 signing, streaming transport, and request-scoped client reuse tests.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server-only", () => ({}));

import {
  B2ObjectNotFoundError,
  B2StorageError,
  createB2StorageClient,
  getB2StorageClient,
  parseB2Config,
  signS3Request,
  type B2Config,
} from "@/lib/server/b2-storage";
import { buildStorageKey } from "@/lib/gathr/ingestion-types";

const BASE_ENV = {
  B2_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
  B2_S3_REGION: "us-west-004",
  B2_BUCKET_NAME: "gathr-private-dev",
  B2_APPLICATION_KEY_ID: "004keyid1234567890",
  B2_APPLICATION_KEY: "K004supersecretapplicationkeyvalue",
};

const VALID_CONFIG: B2Config = {
  endpointOrigin: "https://s3.us-west-004.backblazeb2.com",
  host: "s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
  bucketName: "gathr-private-dev",
  applicationKeyId: "004keyid1234567890",
  applicationKey: "K004supersecretapplicationkeyvalue",
};

const SAMPLE_KEY = buildStorageKey({
  workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  batchId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  documentId: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
  attemptId: "dddddddd-dddd-4ddd-dddd-dddddddddddd",
});

describe("parseB2Config — endpoint, HTTPS, region, and bucket validation", () => {
  it("fails clearly with 503 when required B2 variables are missing", () => {
    expect(() => parseB2Config({})).toThrowError(/not configured/i);
    try {
      parseB2Config({ ...BASE_ENV, B2_APPLICATION_KEY: undefined });
    } catch (err) {
      expect(err).toMatchObject({ status: 503, code: "STORAGE_NOT_CONFIGURED" });
    }
  });

  it("rejects insecure HTTP endpoints and arbitrary non-Backblaze hosts", () => {
    const invalidEndpoints = [
      "http://s3.us-west-004.backblazeb2.com",
      "https://evil.example.com",
      "https://169.254.169.254",
      "https://s3.us-east-1.amazonaws.com",
      "https://user:pass@s3.us-west-004.backblazeb2.com",
      "https://s3.us-west-004.backblazeb2.com/custom-path",
      "https://s3.us-west-004.backblazeb2.com?foo=bar",
      "not-a-url",
    ];

    for (const endpoint of invalidEndpoints) {
      expect(() => parseB2Config({ ...BASE_ENV, B2_S3_ENDPOINT: endpoint })).toThrowError();
    }
  });

  it("rejects mismatched Backblaze endpoint region and invalid bucket names", () => {
    expect(() => parseB2Config({ ...BASE_ENV, B2_S3_REGION: "eu-central-003" })).toThrowError(
      /does not match/i,
    );

    for (const badBucket of ["ab", "UpperBucket", "bad..bucket", "-leading-dash"]) {
      expect(() => parseB2Config({ ...BASE_ENV, B2_BUCKET_NAME: badBucket })).toThrowError(
        /bucket name/i,
      );
    }
  });

  it("normalizes valid HTTPS Backblaze endpoint and region", () => {
    const cfg = parseB2Config({
      ...BASE_ENV,
      B2_S3_ENDPOINT: "https://S3.US-WEST-004.backblazeb2.com/",
      B2_S3_REGION: "US-WEST-004",
    });
    expect(cfg.endpointOrigin).toBe("https://s3.us-west-004.backblazeb2.com");
    expect(cfg.host).toBe("s3.us-west-004.backblazeb2.com");
    expect(cfg.region).toBe("us-west-004");
  });
});

describe("signS3Request & createB2StorageClient", () => {
  it("produces deterministic AWS SigV4 headers and path-style Backblaze URL without host override", async () => {
    const signed = await signS3Request({
      config: VALID_CONFIG,
      method: "PUT",
      key: SAMPLE_KEY,
      extraHeaders: {
        "content-type": "application/pdf",
        "content-length": "123",
      },
      now: new Date("2026-11-26T12:00:00.000Z"),
    });

    expect(signed.url).toBe(
      `https://s3.us-west-004.backblazeb2.com/gathr-private-dev/${SAMPLE_KEY}`,
    );
    expect(signed.headers["x-amz-date"]).toBe("20261126T120000Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(signed.headers["content-type"]).toBe("application/pdf");
    expect(signed.headers["content-length"]).toBe("123");
    expect(signed.headers["host"]).toBeUndefined();
    expect(signed.headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=004keyid1234567890\/20261126\/us-west-004\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("rejects arbitrary or traversal storage keys before making any request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createB2StorageClient(VALID_CONFIG, { fetchFn: fetchMock });

    for (const badKey of [
      "../secret.pdf",
      "other-prefix/a.pdf",
      "gathr/not-uuids/doc.pdf",
      "gathr/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-cccc-cccccccccccc.txt",
    ]) {
      await expect(client.getObject({ key: badKey })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_STORAGE_KEY",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams PUT/GET/DELETE requests, propagates AbortSignal, and scrubs secrets from errors", async () => {
    let capturedInit: RequestInit | undefined;
    const pdfBytes = new TextEncoder().encode("%PDF-1.7\nhello");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        capturedInit = init;
        return new Response(null, { status: 200, headers: { etag: '"abc123"' } });
      })
      .mockImplementationOnce(async () => {
        return new Response(pdfBytes, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": String(pdfBytes.length) },
        });
      })
      .mockImplementationOnce(async () => {
        return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      })
      .mockImplementationOnce(async () => {
        return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      })
      .mockImplementationOnce(async () => {
        return new Response(null, { status: 204 });
      });

    vi.spyOn(console, "error").mockImplementation(() => {});

    const client = createB2StorageClient(VALID_CONFIG, { fetchFn: fetchMock });
    const ac = new AbortController();

    const putRes = await client.putObject({
      key: SAMPLE_KEY,
      body: new ReadableStream({
        start(c) {
          c.enqueue(pdfBytes);
          c.close();
        },
      }),
      contentLength: pdfBytes.length,
      signal: ac.signal,
    });
    expect(putRes.etag).toBe('"abc123"');
    expect(capturedInit?.signal).toBe(ac.signal);

    const getRes = await client.getObject({ key: SAMPLE_KEY });
    expect(getRes.contentLength).toBe(pdfBytes.length);
    const readBytes = new Uint8Array(await new Response(getRes.body).arrayBuffer());
    expect(readBytes).toEqual(pdfBytes);

    await expect(client.getObject({ key: SAMPLE_KEY })).rejects.toBeInstanceOf(
      B2ObjectNotFoundError,
    );

    try {
      await client.getObject({ key: SAMPLE_KEY });
      throw new Error("Expected B2StorageError");
    } catch (err) {
      expect(err).toBeInstanceOf(B2StorageError);
      const msg = (err as Error).message;
      expect(msg).not.toContain(VALID_CONFIG.applicationKey);
      expect(msg).not.toContain(VALID_CONFIG.applicationKeyId);
      expect(msg).not.toContain(SAMPLE_KEY);
    }

    expect(await client.deleteObject({ key: SAMPLE_KEY })).toEqual({ deleted: true });
  });

  it("retries GET and DELETE once on transient connect timeout before succeeding", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7\nretry");
    const timeoutErr = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(
        new Response(pdfBytes, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": String(pdfBytes.length) },
        }),
      )
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = createB2StorageClient(VALID_CONFIG, { fetchFn: fetchMock });
    const obj = await client.getObject({ key: SAMPLE_KEY });
    expect(new Uint8Array(await new Response(obj.body).arrayBuffer())).toEqual(pdfBytes);
    expect(await client.deleteObject({ key: SAMPLE_KEY })).toEqual({ deleted: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reuses client per request without caching credentials globally across requests", () => {
    const req1 = new Request("https://app.test/api/documents/1/upload");
    const req2 = new Request("https://app.test/api/documents/2/upload");

    const prevEnv = {
      B2_S3_ENDPOINT: process.env["B2_S3_ENDPOINT"],
      B2_S3_REGION: process.env["B2_S3_REGION"],
      B2_BUCKET_NAME: process.env["B2_BUCKET_NAME"],
      B2_APPLICATION_KEY_ID: process.env["B2_APPLICATION_KEY_ID"],
      B2_APPLICATION_KEY: process.env["B2_APPLICATION_KEY"],
    };

    try {
      Object.assign(process.env, BASE_ENV);
      const c1a = getB2StorageClient(req1);
      const c1b = getB2StorageClient(req1);
      expect(c1a).toBe(c1b);

      process.env["B2_BUCKET_NAME"] = "other-bucket-name";
      const c2 = getB2StorageClient(req2);
      expect(c2).not.toBe(c1a);
      expect(c1a.bucketName).toBe("gathr-private-dev");
      expect(c2.bucketName).toBe("other-bucket-name");
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
