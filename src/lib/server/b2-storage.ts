import "@tanstack/react-start/server-only";
import { isSafeStorageKey, MAX_FILE_BYTES, PDF_MIME_TYPE } from "@/lib/gathr/ingestion-types";
import { getServerEnv, HttpError, type ServerEnvMap } from "./env";

export interface B2Config {
  endpointOrigin: string;
  host: string;
  region: string;
  bucketName: string;
  applicationKeyId: string;
  applicationKey: string;
}

export interface B2PutObjectInput {
  key: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface B2PutObjectResult {
  etag: string | null;
}

export interface B2GetObjectResult {
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentType: string;
  etag: string | null;
}

export interface B2StorageClient {
  readonly bucketName: string;
  putObject(input: B2PutObjectInput): Promise<B2PutObjectResult>;
  getObject(input: { key: string; signal?: AbortSignal | undefined }): Promise<B2GetObjectResult>;
  deleteObject(input: {
    key: string;
    signal?: AbortSignal | undefined;
  }): Promise<{ deleted: boolean }>;
}

export class B2StorageError extends Error {
  readonly status: number;
  readonly s3Code: string | undefined;
  readonly retryable: boolean;

  constructor(
    status: number,
    message: string,
    s3Code?: string | undefined,
    retryable = status === 408 || status === 429 || status >= 500,
  ) {
    super(message);
    this.name = "B2StorageError";
    this.status = status;
    this.s3Code = s3Code;
    this.retryable = retryable;
  }
}

export class B2ObjectNotFoundError extends B2StorageError {
  constructor(message = "Stored object was not found.") {
    super(404, message, "NoSuchKey", false);
    this.name = "B2ObjectNotFoundError";
  }
}

const B2_HOST_REGEX = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i;
const B2_REGION_REGEX = /^[a-z0-9-]+$/i;
const S3_BUCKET_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const MAX_ERROR_BODY_BYTES = 8192;

export function parseB2Config(env: ServerEnvMap): B2Config {
  const endpointRaw = env.B2_S3_ENDPOINT?.trim();
  const regionRaw = env.B2_S3_REGION?.trim();
  const bucketRaw = env.B2_BUCKET_NAME?.trim();
  const keyId = env.B2_APPLICATION_KEY_ID?.trim();
  const keySecret = env.B2_APPLICATION_KEY?.trim();

  if (!endpointRaw || !regionRaw || !bucketRaw || !keyId || !keySecret) {
    throw new HttpError(503, "Object storage is not configured.", "STORAGE_NOT_CONFIGURED");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpointRaw);
  } catch {
    throw new HttpError(
      500,
      "Object storage endpoint configuration is invalid.",
      "STORAGE_CONFIG_INVALID",
    );
  }

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    (parsedUrl.pathname !== "/" && parsedUrl.pathname !== "")
  ) {
    throw new HttpError(
      500,
      "Object storage endpoint must be a clean HTTPS Backblaze B2 origin.",
      "STORAGE_CONFIG_INVALID",
    );
  }

  const hostMatch = B2_HOST_REGEX.exec(parsedUrl.hostname);
  const hostRegion = hostMatch?.[1]?.toLowerCase();
  const region = regionRaw.toLowerCase();
  if (!hostRegion || !B2_REGION_REGEX.test(region) || hostRegion !== region) {
    throw new HttpError(
      500,
      "Object storage endpoint does not match configured Backblaze B2 region.",
      "STORAGE_CONFIG_INVALID",
    );
  }

  if (!S3_BUCKET_REGEX.test(bucketRaw) || bucketRaw.includes("..")) {
    throw new HttpError(
      500,
      "Object storage bucket name configuration is invalid.",
      "STORAGE_CONFIG_INVALID",
    );
  }

  return {
    endpointOrigin: parsedUrl.origin,
    host: parsedUrl.host.toLowerCase(),
    region,
    bucketName: bucketRaw,
    applicationKeyId: keyId,
    applicationKey: keySecret,
  };
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildS3ObjectPath(bucketName: string, key: string): string {
  const encodedBucket = encodeRfc3986(bucketName);
  const encodedKey = key
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
  return `/${encodedBucket}/${encodedKey}`;
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString();
  const compact = iso.replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: compact,
    dateStamp: compact.slice(0, 8),
  };
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(digest);
}

async function hmacSha256Raw(keyBytes: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return globalThis.crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256Raw(encoder.encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmacSha256Raw(kDate, region);
  const kService = await hmacSha256Raw(kRegion, "s3");
  return hmacSha256Raw(kService, "aws4_request");
}

export interface SignedS3Request {
  url: string;
  headers: Record<string, string>;
}

export async function signS3Request(params: {
  config: B2Config;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  key: string;
  extraHeaders?: Record<string, string> | undefined;
  now?: Date | undefined;
  signingKeyCache?: Map<string, Promise<ArrayBuffer>> | undefined;
}): Promise<SignedS3Request> {
  if (!isSafeStorageKey(params.key)) {
    throw new HttpError(400, "Invalid object storage key.", "INVALID_STORAGE_KEY");
  }

  const canonicalUri = buildS3ObjectPath(params.config.bucketName, params.key);
  const url = `${params.config.endpointOrigin}${canonicalUri}`;
  const { amzDate, dateStamp } = formatAmzDate(params.now ?? new Date());

  const normalizedHeaders: Record<string, string> = {
    host: params.config.host,
    "x-amz-content-sha256": UNSIGNED_PAYLOAD,
    "x-amz-date": amzDate,
  };

  if (params.extraHeaders) {
    for (const [rawName, rawValue] of Object.entries(params.extraHeaders)) {
      const name = rawName.trim().toLowerCase();
      if (!name) continue;
      normalizedHeaders[name] = rawValue.trim().replace(/\s+/g, " ");
    }
  }

  const sortedHeaderNames = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${normalizedHeaders[name]}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");

  const canonicalRequest = [
    params.method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const credentialScope = `${dateStamp}/${params.config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let signingKeyPromise = params.signingKeyCache?.get(dateStamp);
  if (!signingKeyPromise) {
    signingKeyPromise = deriveSigningKey(
      params.config.applicationKey,
      dateStamp,
      params.config.region,
    );
    if (params.signingKeyCache) {
      if (params.signingKeyCache.size >= 4) {
        params.signingKeyCache.clear();
      }
      params.signingKeyCache.set(dateStamp, signingKeyPromise);
    }
  }

  const signingKey = await signingKeyPromise;
  const signature = toHex(await hmacSha256Raw(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${params.config.applicationKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders: Record<string, string> = {};
  for (const name of sortedHeaderNames) {
    if (name === "host") continue;
    const value = normalizedHeaders[name];
    if (value !== undefined) {
      requestHeaders[name] = value;
    }
  }
  requestHeaders["authorization"] = authorization;

  return { url, headers: requestHeaders };
}

async function readBoundedErrorText(response: Response): Promise<string> {
  if (!response.body) {
    try {
      const text = await response.text();
      return text.slice(0, MAX_ERROR_BODY_BYTES);
    } catch {
      return "";
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BODY_BYTES - total;
      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        break;
      }
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += slice.byteLength;
      out += decoder.decode(slice, { stream: true });
      if (total >= MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    out += decoder.decode();
    return out;
  } catch {
    return out;
  }
}

function extractS3XmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]{1,200})</${tag}>`, "i").exec(xml);
  return match?.[1]?.trim();
}

async function mapB2FailureResponse(
  response: Response,
  operation: string,
): Promise<B2StorageError> {
  const body = await readBoundedErrorText(response);
  const s3Code = extractS3XmlTag(body, "Code");
  if (response.status === 404 || s3Code === "NoSuchKey") {
    return new B2ObjectNotFoundError();
  }
  console.error(`[b2] ${operation} failed`, {
    status: response.status,
    s3Code: s3Code ?? null,
  });
  return new B2StorageError(
    response.status,
    `Object storage ${operation} failed (${response.status}).`,
    s3Code,
  );
}

async function fetchWithConnectRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    const causeCode =
      typeof error === "object" && error !== null
        ? ((error as { cause?: { code?: unknown } }).cause?.code ??
          (error as { code?: unknown }).code)
        : undefined;
    if (
      causeCode !== "UND_ERR_CONNECT_TIMEOUT" &&
      causeCode !== "ECONNREFUSED" &&
      causeCode !== "EAI_AGAIN" &&
      causeCode !== "ENOTFOUND" &&
      causeCode !== "ETIMEDOUT"
    ) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return fetchFn(url, init);
  }
}

export function createB2StorageClient(
  config: B2Config,
  options?: {
    fetchFn?: typeof fetch | undefined;
    nowFn?: (() => Date) | undefined;
  },
): B2StorageClient {
  const fetchFn = options?.fetchFn ?? fetch;
  const nowFn = options?.nowFn ?? (() => new Date());
  const signingKeyCache = new Map<string, Promise<ArrayBuffer>>();

  return {
    bucketName: config.bucketName,

    async putObject({ key, body, contentLength, contentType = PDF_MIME_TYPE, signal }) {
      if (!isSafeStorageKey(key)) {
        throw new HttpError(400, "Invalid object storage key.", "INVALID_STORAGE_KEY");
      }
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength <= 0 ||
        contentLength > MAX_FILE_BYTES
      ) {
        throw new HttpError(400, "Invalid object content length.", "INVALID_CONTENT_LENGTH");
      }

      const signed = await signS3Request({
        config,
        method: "PUT",
        key,
        extraHeaders: {
          "content-type": contentType,
          "content-length": String(contentLength),
        },
        now: nowFn(),
        signingKeyCache,
      });

      const init: RequestInit & { duplex?: "half" } = {
        method: "PUT",
        headers: signed.headers,
        body,
        duplex: "half",
        ...(signal ? { signal } : {}),
      };

      const response = await fetchFn(signed.url, init);
      if (!response.ok) {
        throw await mapB2FailureResponse(response, "putObject");
      }
      await response.body?.cancel().catch(() => {});
      return { etag: response.headers.get("etag") };
    },

    async getObject({ key, signal }) {
      if (!isSafeStorageKey(key)) {
        throw new HttpError(400, "Invalid object storage key.", "INVALID_STORAGE_KEY");
      }

      const signed = await signS3Request({
        config,
        method: "GET",
        key,
        now: nowFn(),
        signingKeyCache,
      });

      const response = await fetchWithConnectRetry(fetchFn, signed.url, {
        method: "GET",
        headers: signed.headers,
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        throw await mapB2FailureResponse(response, "getObject");
      }
      if (!response.body) {
        throw new B2StorageError(502, "Object storage returned an empty body.", "EMPTY_BODY", true);
      }

      const rawLength = response.headers.get("content-length");
      const parsedLength = rawLength !== null ? Number(rawLength) : NaN;
      const contentLength =
        Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null;

      return {
        body: response.body,
        contentLength,
        contentType: response.headers.get("content-type") || PDF_MIME_TYPE,
        etag: response.headers.get("etag"),
      };
    },

    async deleteObject({ key, signal }) {
      if (!isSafeStorageKey(key)) {
        throw new HttpError(400, "Invalid object storage key.", "INVALID_STORAGE_KEY");
      }

      const signed = await signS3Request({
        config,
        method: "DELETE",
        key,
        now: nowFn(),
        signingKeyCache,
      });

      const response = await fetchWithConnectRetry(fetchFn, signed.url, {
        method: "DELETE",
        headers: signed.headers,
        ...(signal ? { signal } : {}),
      });

      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return { deleted: false };
      }
      if (!response.ok) {
        throw await mapB2FailureResponse(response, "deleteObject");
      }
      await response.body?.cancel().catch(() => {});
      return { deleted: true };
    },
  };
}

const requestScopedClients = new WeakMap<Request, B2StorageClient>();

/**
 * Returns a request-scoped Backblaze B2 S3 client without caching credentials
 * in module-level globals across unrelated requests or worker isolates.
 */
export function getB2StorageClient(
  request?: Request,
  directEnv?: Record<string, unknown>,
): B2StorageClient {
  if (request && !directEnv) {
    const existing = requestScopedClients.get(request);
    if (existing) return existing;
  }

  const config = parseB2Config(getServerEnv(request, directEnv));
  const client = createB2StorageClient(config);

  if (request && !directEnv) {
    requestScopedClients.set(request, client);
  }
  return client;
}
