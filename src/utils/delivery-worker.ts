import { env } from '~/env/server';
import { parseKey } from './s3-utils';

const deliveryWorkerEndpoint = `${env.DELIVERY_WORKER_ENDPOINT}?token=${env.DELIVERY_WORKER_TOKEN}`;
const storageResolverEndpoint = env.STORAGE_RESOLVER_ENDPOINT;
const storageResolverAuth = env.STORAGE_RESOLVER_AUTH; // format: username:password

export type DownloadInfo = {
  url: string;
  urlExpiryDate: Date;
};

/**
 * Thrown by `getDownloadUrl` when the delivery worker responds non-OK for every
 * key candidate. Carries the upstream HTTP `statusCode` so callers can tell a
 * client error (404 not-found / 400 malformed key → the key doesn't resolve to a
 * stored file) apart from a transient backend/storage failure (5xx, or a
 * network-layer failure that never produces a status). Without this distinction
 * a caller can only see a generic thrown Error and would have to guess — masking
 * a real storage outage as "not found" (or a bad key as a 500).
 *
 * `statusCode` is the delivery worker's HTTP status. It is `undefined` only when
 * the failure happened before a response existed (a `fetch` transport reject),
 * in which case this error is never thrown — the transport error propagates
 * as-is — so in practice `statusCode` is always set on a `DeliveryWorkerError`.
 */
export class DeliveryWorkerError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, statusText: string) {
    // Keep the historical "Delivery worker error: …" message so existing
    // callers/log-matchers that key off it are unaffected.
    super(`Delivery worker error: ${statusText}`);
    this.name = 'DeliveryWorkerError';
    this.statusCode = statusCode;
  }
}

/**
 * `decodeURIComponent` throws `URIError: URI malformed` on a value with a
 * broken/truncated percent-sequence (e.g. a lone `%`, `%E0%A4%A`). Some stored
 * `file.url` / filename values are already-encoded or contain raw `%` literals,
 * so a bare `decodeURIComponent` on the download path throws → caught upstream →
 * 500 on every download of that file. Decode best-effort: when decoding is not
 * possible, fall back to the raw value (the storage-resolver / delivery-worker
 * can still resolve it from the raw key) instead of throwing.
 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type BucketInfo = {
  name: string;
  createdDate: Date;
};

export type DeliveryWorkerStatus = {
  current: BucketInfo | null;
  all: BucketInfo[];
};

/**
 * Get download URL via the storage-resolver microservice.
 * The resolver handles multi-backend storage (Cloudflare, Backblaze, MinIO).
 */
export async function getDownloadUrlByFileId(
  fileId: number,
  fileName?: string
): Promise<DownloadInfo> {
  if (!storageResolverEndpoint) {
    throw new Error('STORAGE_RESOLVER_ENDPOINT is not configured');
  }

  const body = JSON.stringify({
    fileId,
    fileName: fileName ? safeDecodeURIComponent(fileName) : undefined,
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (storageResolverAuth) {
    headers['Authorization'] = `Basic ${Buffer.from(storageResolverAuth).toString('base64')}`;
  }

  const response = await fetch(`${storageResolverEndpoint}/resolve`, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Storage resolver error: ${errorText}`);
  }

  const result = await response.json();
  return {
    url: result.url,
    urlExpiryDate: new Date(result.urlExpiryDate),
  };
}

/**
 * Check if the storage resolver is enabled.
 */
export function isStorageResolverEnabled(): boolean {
  return !!storageResolverEndpoint;
}

/**
 * Resolve a download URL for a file, using the storage resolver when available
 * and falling back to the delivery worker (legacy path).
 */
export async function resolveDownloadUrl(
  fileId: number,
  fileUrl: string,
  fileName?: string
): Promise<DownloadInfo> {
  if (isStorageResolverEnabled()) {
    try {
      return await getDownloadUrlByFileId(fileId, fileName);
    } catch {
      // Fall back to delivery worker when the storage resolver doesn't have
      // this file (e.g. File table records like BountyEntry attachments that
      // aren't synced to file_locations).
      return getDownloadUrl(fileUrl, fileName);
    }
  }
  return getDownloadUrl(fileUrl, fileName);
}

/**
 * Get download URL via the delivery worker (legacy path).
 * Used when storage resolver is not configured.
 */
export async function getDownloadUrl(fileUrl: string, fileName?: string) {
  const { key } = parseKey(fileUrl);
  // Some of our old file keys should not be decoded. `safeDecodeURIComponent`
  // never throws on a malformed/already-encoded key — it falls back to the raw
  // key, which is already the second candidate, so a bad key still tries the raw
  // form instead of 500ing the whole download.
  const keys = [safeDecodeURIComponent(key), key];

  let i = 0;
  let response: Response = new Response();

  // We will test with all key configurations we can:
  while (i < keys.length) {
    const body = JSON.stringify({
      key: keys[i],
      fileName: fileName ? safeDecodeURIComponent(fileName) : undefined,
    });

    response = await fetch(deliveryWorkerEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    i++;

    if (response.ok) {
      break;
    }
  }

  if (!response.ok) {
    throw new DeliveryWorkerError(response.status, response.statusText);
  }
  const result = await response.json();
  return result as DownloadInfo;
}
