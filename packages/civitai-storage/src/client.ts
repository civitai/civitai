// Server-side HTTP client for the Civitai storage service (STORAGE_ENDPOINT). Owns the transport
// (fetch + retry + status→error) and typed per-endpoint methods mirroring the monolith's s3-utils
// network ops. The service holds the bucket credentials; callers hold only an endpoint + shared token.
// Domain logic (ModelFile refcount guards, media-location registration, bucket allowlists) stays in
// the consuming app on top of these methods. Presign methods return a URL the caller uses to transfer
// bytes DIRECTLY to/from S3 — bytes never flow through the service.
import {
  presignResult,
  presignMultipartResult,
  headObjectResult,
  createMultipartResult,
  presignPartResult,
  type DeleteObjectInput,
  type DeleteManyObjectsInput,
  type HeadObjectInput,
  type HeadObjectResult,
  type PresignPutInput,
  type PresignGetInput,
  type PresignResult,
  type PresignMultipartInput,
  type PresignMultipartResult,
  type CompleteMultipartInput,
  type AbortMultipartInput,
  type CreateMultipartInput,
  type CreateMultipartResult,
  type PresignPartInput,
  type PresignPartResult,
  type MultipartPart,
  type StorageBackend,
} from './schema';

const DEFAULT_STREAM_CHUNK_SIZE = 100 * 1024 * 1024; // 100MB — matches the monolith's moveAssetFromBlob

// Merge buffered pieces into one contiguous Uint8Array of `totalBytes`.
function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Re-chunk an arbitrary byte stream into `chunkSize` pieces (the last may be smaller). Bounded memory:
// only up to ~chunkSize is buffered at a time, regardless of the source's total size.
async function* chunkStream(
  source: AsyncIterable<Uint8Array>,
  chunkSize: number
): AsyncGenerator<Uint8Array> {
  let buffer: Uint8Array[] = [];
  let buffered = 0;
  for await (const piece of source) {
    if (piece.byteLength === 0) continue;
    buffer.push(piece);
    buffered += piece.byteLength;
    while (buffered >= chunkSize) {
      const merged = concatChunks(buffer, buffered);
      yield merged.subarray(0, chunkSize);
      const rest = merged.subarray(chunkSize);
      buffer = rest.byteLength ? [rest] : [];
      buffered = rest.byteLength;
    }
  }
  if (buffered > 0) yield concatChunks(buffer, buffered);
}

// PUT one part's bytes to a presigned URL and return its ETag. Server-side (no XHR/progress).
async function putBytesTo(
  fetchImpl: typeof fetch,
  url: string,
  body: Uint8Array
): Promise<string | null> {
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    // fetch accepts a Uint8Array at runtime, but the static body type differs between the DOM and Node
    // lib typings (and `BodyInit` isn't a name under Node-only libs). Cast to ArrayBuffer — a BodyInit
    // member in both — so this compiles wherever the (server-only) client is consumed.
    body: body as unknown as ArrayBuffer,
  });
  if (!res.ok) {
    throw new StorageClientError(`part upload failed (${res.status})`, res.status, res.status >= 500);
  }
  return res.headers.get('etag');
}

export type StorageClientConfig = {
  /** Base URL of the storage app, e.g. `http://storage.civitai-app.svc`. Falls back to
   * `process.env.STORAGE_ENDPOINT`. */
  endpoint?: string;
  /** Shared secret for the internal-only ingress. Falls back to `process.env.STORAGE_TOKEN`. */
  token?: string;
  /** Override fetch (tests / non-global-fetch runtimes). */
  fetch?: typeof fetch;
  /** Per-ATTEMPT timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Max RETRIES on transient failures (transport/timeout/5xx/429). Default 2 → up to 3 attempts.
   * Only transient failures retry; a 4xx throws immediately. All ops are idempotent. */
  retries?: number;
  /** Base backoff in ms; grows exponentially (`base * 2^attempt`) with jitter, capped at 2s. Default 200. */
  retryBaseMs?: number;
  /** Called once per FINAL request failure (after retries). Wire to your logger; never throws to the
   * caller. The package stays dependency-free. */
  onFailure?: (failure: StorageRequestFailure) => void;
};

export class StorageClientError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'StorageClientError';
  }
}

export type StorageRequestFailure = {
  path: string;
  status?: number;
  retryable: boolean;
  attempts: number;
  message: string;
};

function safeReport(onFailure: StorageClientConfig['onFailure'], failure: StorageRequestFailure) {
  if (!onFailure) return;
  try {
    onFailure(failure);
  } catch {
    // A logger error must never affect the caller or mask the original request failure.
  }
}

function resolveConfig(config: StorageClientConfig) {
  const endpoint = config.endpoint ?? process.env.STORAGE_ENDPOINT;
  if (!endpoint) {
    throw new StorageClientError(
      'No storage endpoint configured (pass `endpoint` or set STORAGE_ENDPOINT).'
    );
  }
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new StorageClientError('No fetch implementation available (pass `fetch`).');
  return {
    endpoint: endpoint.replace(/\/$/, ''),
    token: config.token ?? process.env.STORAGE_TOKEN ?? '',
    fetch: fetchImpl,
    timeoutMs: config.timeoutMs ?? 10_000,
    retries: config.retries ?? 2,
    retryBaseMs: config.retryBaseMs ?? 200,
    onFailure: config.onFailure,
  };
}

async function postAttempt(
  url: string,
  body: unknown,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      throw new StorageClientError(
        `storage request failed (${res.status})${text ? `: ${text}` : ''}`,
        res.status,
        retryable
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch (err) {
    if (err instanceof StorageClientError) throw err;
    // Transport error, abort/timeout, or JSON parse failure — transient; retryable.
    throw new StorageClientError((err as Error).message, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

// Reports to `onFailure` exactly once per FINAL failure — the single choke point every request flows through.
async function post(path: string, body: unknown, config: StorageClientConfig): Promise<unknown> {
  let resolved: ReturnType<typeof resolveConfig>;
  try {
    resolved = resolveConfig(config);
  } catch (err) {
    const e = err as StorageClientError;
    safeReport(config.onFailure, { path, status: e.status, retryable: false, attempts: 0, message: e.message });
    throw e;
  }
  const { endpoint, token, fetch: fetchImpl, timeoutMs, retries, retryBaseMs, onFailure } = resolved;
  const url = `${endpoint}${path}`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await postAttempt(url, body, token, fetchImpl, timeoutMs);
    } catch (err) {
      const e = err as StorageClientError;
      if (!e.retryable || attempt >= retries) {
        safeReport(onFailure, {
          path,
          status: e.status,
          retryable: e.retryable,
          attempts: attempt + 1,
          message: e.message,
        });
        throw e;
      }
      const backoff = Math.min(retryBaseMs * 2 ** attempt, 2000) + Math.random() * retryBaseMs;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

/**
 * Build a storage client bound to `config`. Methods throw `StorageClientError` on a non-2xx/transport
 * failure (after retries). Deletes/head/multipart-control are round-trips; presign methods return a URL
 * for a DIRECT client↔S3 transfer.
 */
export function createStorageClient(config: StorageClientConfig = {}) {
  return {
    deleteObject: async (input: DeleteObjectInput): Promise<void> => {
      await post('/objects/delete', input, config);
    },

    deleteManyObjects: async (input: DeleteManyObjectsInput): Promise<void> => {
      await post('/objects/delete-many', input, config);
    },

    headObject: async (input: HeadObjectInput): Promise<HeadObjectResult> => {
      return headObjectResult.parse(await post('/objects/head', input, config));
    },

    checkFileExists: async (input: HeadObjectInput): Promise<boolean> => {
      const res = headObjectResult.parse(await post('/objects/head', input, config));
      return res.exists;
    },

    getPutUrl: async (input: PresignPutInput): Promise<PresignResult> => {
      return presignResult.parse(await post('/presign/put', input, config));
    },

    getGetUrl: async (input: PresignGetInput): Promise<PresignResult> => {
      return presignResult.parse(await post('/presign/get', input, config));
    },

    getMultipartPutUrl: async (input: PresignMultipartInput): Promise<PresignMultipartResult> => {
      return presignMultipartResult.parse(await post('/presign/multipart', input, config));
    },

    completeMultipartUpload: async (input: CompleteMultipartInput): Promise<void> => {
      await post('/multipart/complete', input, config);
    },

    abortMultipartUpload: async (input: AbortMultipartInput): Promise<void> => {
      await post('/multipart/abort', input, config);
    },

    createMultipartUpload: async (input: CreateMultipartInput): Promise<CreateMultipartResult> => {
      return createMultipartResult.parse(await post('/multipart/create', input, config));
    },

    presignUploadPart: async (input: PresignPartInput): Promise<PresignPartResult> => {
      return presignPartResult.parse(await post('/multipart/presign-part', input, config));
    },

    // Server-side streaming multipart: create → presign each part on demand → PUT it → complete.
    // For large/unknown-size sources (e.g. piping a fetch body to storage). Buffers ~one `chunkSize`
    // part at a time (bounded memory), not the whole object. Aborts the upload on any failure.
    uploadStream: async (
      params: {
        key: string;
        backend?: StorageBackend;
        bucket?: string;
        mimeType?: string;
        chunkSize?: number;
        partExpiresIn?: number;
      },
      source: AsyncIterable<Uint8Array>,
      options: { onProgress?: (loadedBytes: number) => void } = {}
    ): Promise<{ bucket: string; key: string; parts: MultipartPart[] }> => {
      const backend = params.backend ?? 'default';
      const chunkSize = params.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;
      const fetchImpl = config.fetch ?? globalThis.fetch;
      if (!fetchImpl) throw new StorageClientError('No fetch implementation available (pass `fetch`).');

      const { uploadId, bucket, key } = createMultipartResult.parse(
        await post(
          '/multipart/create',
          { backend, bucket: params.bucket, key: params.key, mimeType: params.mimeType },
          config
        )
      );

      const parts: MultipartPart[] = [];
      let loaded = 0;
      try {
        let partNumber = 1;
        for await (const chunk of chunkStream(source, chunkSize)) {
          const { url } = presignPartResult.parse(
            await post(
              '/multipart/presign-part',
              { backend, bucket, key, uploadId, partNumber, expiresIn: params.partExpiresIn },
              config
            )
          );
          const etag = await putBytesTo(fetchImpl, url, chunk);
          if (!etag) {
            throw new StorageClientError(
              `missing ETag for part ${partNumber} — the bucket CORS must expose the ETag response header`
            );
          }
          parts.push({ ETag: etag, PartNumber: partNumber });
          loaded += chunk.byteLength;
          options.onProgress?.(loaded);
          partNumber++;
        }
        await post('/multipart/complete', { backend, bucket, key, uploadId, parts }, config);
        return { bucket, key, parts };
      } catch (err) {
        // Best-effort abort so a partial upload doesn't linger (and accrue storage) after a failure.
        await post('/multipart/abort', { backend, bucket, key, uploadId }, config).catch(() => {});
        throw err;
      }
    },

    // Read an object's bytes server-side: presign a GET, then fetch it (bytes never flow through the
    // storage service). For server consumers that need the content itself (e.g. dataset reads).
    getObjectBuffer: async (input: PresignGetInput): Promise<ArrayBuffer> => {
      const { url } = presignResult.parse(await post('/presign/get', input, config));
      const fetchImpl = config.fetch ?? globalThis.fetch;
      if (!fetchImpl) throw new StorageClientError('No fetch implementation available (pass `fetch`).');
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new StorageClientError(`object read failed (${res.status})`, res.status, res.status >= 500);
      }
      return res.arrayBuffer();
    },
  };
}

export type StorageClient = ReturnType<typeof createStorageClient>;
