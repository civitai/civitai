// Browser-safe upload execution. Consumes a presign response (from the server-only createStorageClient,
// relayed to the caller) and PUTs the bytes DIRECTLY to S3 — the transfer never touches the storage
// service. Pure fetch/XHR + the File/Blob API: NO secrets, NO node deps, safe in a browser bundle.
// Deliberately a SEPARATE entry (`@civitai/storage/upload`) from the server-only client so neither
// pulls the other into the wrong bundle.
//
// The multipart uploader returns the assembled `parts[]`; it does NOT finalize — completing/aborting a
// multipart upload requires the storage token, so the SERVER calls completeMultipartUpload /
// abortMultipartUpload (via the client) with the returned parts. Browser uploads, server finalizes.
//
// NOTE: reading the S3 `ETag` response header cross-origin requires the bucket's CORS to expose it
// (`ExposeHeaders: ETag`). Without that, multipart completion can't get the ETags — surfaced as a clear
// error rather than a silent corrupt object.
import type { MultipartPart, PresignMultipartResult } from './schema';

export type UploadProgress = {
  /** Bytes uploaded so far. */
  loaded: number;
  /** Total bytes. */
  total: number;
  /** 0–100. */
  percent: number;
  /** Bytes/sec since the upload started (0 until measurable). */
  speed: number;
};

export type UploadOptions = {
  contentType?: string;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
};

export type MultipartUploadOptions = {
  /** Retries per part on a transient failure (default 3). */
  retries?: number;
  /** Base backoff (ms) between part retries; grows linearly with the attempt (default 1000). */
  retryBaseMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
};

export type MultipartUploadResult = {
  parts: MultipartPart[];
  bucket: string;
  key: string;
  uploadId: string;
};

type UploadBody = Blob | ArrayBuffer | Uint8Array;

function byteLength(body: UploadBody): number {
  if (body instanceof Blob) return body.size;
  if (body instanceof Uint8Array) return body.byteLength;
  return body.byteLength;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('The upload was aborted', 'AbortError')
    : Object.assign(new Error('The upload was aborted'), { name: 'AbortError' });
}

// PUT one blob to a presigned URL and return its S3 ETag. Uses XHR when available (for upload progress);
// falls back to fetch (no granular progress) in non-browser runtimes.
function putBlob(
  url: string,
  body: UploadBody,
  options: { contentType?: string; signal?: AbortSignal; onPartProgress?: (loaded: number) => void }
): Promise<{ etag: string | null }> {
  const contentType = options.contentType ?? 'application/octet-stream';
  const { signal, onPartProgress } = options;

  if (typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', contentType);
      if (onPartProgress) {
        xhr.upload.addEventListener('progress', (e) => onPartProgress(e.loaded));
      }
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve({ etag: xhr.getResponseHeader('ETag') });
        else reject(new Error(`upload failed (${xhr.status})`));
      });
      xhr.addEventListener('error', () => reject(new Error('upload network error')));
      xhr.addEventListener('abort', () => reject(abortError()));
      if (signal) {
        if (signal.aborted) return reject(abortError());
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(body as XMLHttpRequestBodyInit);
    });
  }

  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: body as BodyInit,
    signal,
  }).then((res) => {
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
    onPartProgress?.(byteLength(body));
    return { etag: res.headers.get('etag') };
  });
}

/**
 * PUT a single object to a presigned PUT URL (from `client.getPutUrl`). Returns the S3 ETag when the
 * response exposes it (may be null if bucket CORS doesn't). For files large enough to warrant chunking,
 * use `uploadMultipart` instead.
 */
export async function uploadToPresignedUrl(
  url: string,
  body: UploadBody,
  options: UploadOptions = {}
): Promise<{ etag: string | null }> {
  const total = byteLength(body);
  const start = Date.now();
  return putBlob(url, body, {
    contentType: options.contentType,
    signal: options.signal,
    onPartProgress: options.onProgress
      ? (loaded) => {
          const seconds = (Date.now() - start) / 1000;
          options.onProgress!({
            loaded,
            total,
            percent: total ? (loaded / total) * 100 : 0,
            speed: seconds > 0 ? loaded / seconds : 0,
          });
        }
      : undefined,
  });
}

/**
 * Upload a file across a multipart presign response (from `client.getMultipartPutUrl`): slice by the
 * server-echoed `chunkSize`, PUT each part (with retry), and return the assembled `parts[]` for the
 * SERVER to pass to `completeMultipartUpload`. Throws on a part that fails after retries (or on abort) —
 * the caller should then call `abortMultipartUpload` with the presign's `uploadId`.
 */
export async function uploadMultipart(
  presign: PresignMultipartResult,
  file: Blob,
  options: MultipartUploadOptions = {}
): Promise<MultipartUploadResult> {
  const { urls, bucket, key, uploadId, chunkSize } = presign;
  const retries = options.retries ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 1000;
  const total = file.size;
  const partsCount = urls.length;
  const start = Date.now();
  let baseUploaded = 0; // bytes from already-completed parts
  const parts: MultipartPart[] = [];

  const report = (currentPartLoaded: number) => {
    if (!options.onProgress) return;
    const loaded = baseUploaded + currentPartLoaded;
    const seconds = (Date.now() - start) / 1000;
    options.onProgress({
      loaded,
      total,
      percent: total ? (loaded / total) * 100 : 0,
      speed: seconds > 0 ? loaded / seconds : 0,
    });
  };

  const ordered = [...urls].sort((a, b) => a.partNumber - b.partNumber);
  for (const { url, partNumber } of ordered) {
    if (options.signal?.aborted) throw abortError();

    const begin = (partNumber - 1) * chunkSize;
    const end = partNumber === partsCount ? file.size : partNumber * chunkSize;
    const blob = file.slice(begin, end);

    let attempt = 0;
    let etag: string | null = null;
    for (;;) {
      try {
        ({ etag } = await putBlob(url, blob, {
          signal: options.signal,
          onPartProgress: (loaded) => report(loaded),
        }));
        break;
      } catch (err) {
        if (options.signal?.aborted) throw err;
        attempt++;
        if (attempt > retries) throw err;
        await delay(retryBaseMs * attempt);
      }
    }

    if (!etag) {
      throw new Error(
        `missing ETag for part ${partNumber} — the bucket CORS must expose the ETag response header`
      );
    }
    parts.push({ ETag: etag, PartNumber: partNumber });
    baseUploaded += blob.size;
    report(0);
  }

  return { parts, bucket, key, uploadId };
}
