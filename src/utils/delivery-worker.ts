import { env } from '~/env/server';
import { parseKey } from './s3-utils';

const deliveryWorkerEndpoint = `${env.DELIVERY_WORKER_ENDPOINT}?token=${env.DELIVERY_WORKER_TOKEN}`;
const storageResolverEndpoint = env.STORAGE_RESOLVER_ENDPOINT;
const storageResolverAuth = env.STORAGE_RESOLVER_AUTH; // format: username:password
// The resolver's INTERNAL_API_TOKEN. Required to ask for an origin-direct URL —
// see `getDownloadUrlByFileId`. Same credential the register/deregister calls in
// `~/server/services/storage-resolver` already use.
const storageResolverInternalToken = env.STORAGE_RESOLVER_INTERNAL_TOKEN;

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
  /**
   * Set by `resolveDownloadUrl` when the storage resolver was consulted FIRST and
   * also failed, so this delivery-worker error is the second of two answers.
   *
   * 🔴 Load-bearing for `isDefiniteNotFound`. The delivery worker is the legacy
   * path keyed off `ModelFile.url`; a file whose bytes are registered only in
   * `file_locations` is resolvable ONLY through the storage resolver. So when the
   * resolver could not answer, a delivery-worker 404 does not mean the object is
   * absent — it can equally mean "the only component that could have found it was
   * down". Keeping the resolver's error here is what lets the two be told apart.
   */
  resolverError?: unknown;
  constructor(statusCode: number, statusText: string) {
    // Keep the historical "Delivery worker error: …" message so existing
    // callers/log-matchers that key off it are unaffected.
    super(`Delivery worker error: ${statusText}`);
    this.name = 'DeliveryWorkerError';
    this.statusCode = statusCode;
  }
}

/**
 * Thrown by `getDownloadUrlByFileId` when the storage resolver responds non-OK.
 * Carries the resolver's HTTP `statusCode` for the same reason
 * `DeliveryWorkerError` does: a caller must be able to tell "this file is not
 * there" (404) from "the resolver could not answer" (5xx, auth, rate limit).
 *
 * This previously threw a bare `Error`, which discarded the status — so every
 * failure mode looked identical downstream. `createModelFileScanRequest` then
 * treated all of them as `not-found` and wrote a PERMANENT `ModelFile.exists=false`
 * tombstone, which also permanently excludes the file from ever being scanned
 * (see `scanFilesFallbackJob`'s `exists` filter). Measured 2026-08-20: 41 of 41
 * readable tombstoned files were still fully downloadable, so the tombstones were
 * recording resolver outages, not missing objects.
 */
export class StorageResolverError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, errorText: string) {
    // Keep the historical "Storage resolver error: …" message so existing
    // callers/log-matchers that key off it are unaffected.
    super(`Storage resolver error: ${errorText}`);
    this.name = 'StorageResolverError';
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
/**
 * Options that only the storage resolver understands. The delivery-worker
 * fallback silently ignores them, which is correct: it is the legacy path keyed
 * off `ModelFile.url` and has no notion of which host serves the bytes.
 */
export type ResolveOptions = {
  /**
   * Ask for a URL addressing the storage origin rather than the CDN in front of
   * it. Only honoured for backends that have a second address; ignored otherwise.
   *
   * Serving a file directly costs more than serving it through the CDN, so this
   * should be set only for callers that measurably benefit. See
   * `shouldResolveDirect`.
   */
  direct?: boolean;
};

export async function getDownloadUrlByFileId(
  fileId: number,
  fileName?: string,
  options?: ResolveOptions
): Promise<DownloadInfo> {
  if (!storageResolverEndpoint) {
    throw new Error('STORAGE_RESOLVER_ENDPOINT is not configured');
  }

  // 🔴 The resolver only honours `direct` for a caller presenting the internal
  // bearer token, because /resolve is publicly reachable and `direct` moves bytes
  // onto our billed egress allowance. Without the token we do not ask at all,
  // rather than asking and being refused: the resolver's granted="unauthorized"
  // counter is the signal that someone found the cost lever, and our own
  // misconfiguration must not be what fills it.
  const canRequestDirect = Boolean(options?.direct && storageResolverInternalToken);

  const body = JSON.stringify({
    fileId,
    fileName: fileName ? safeDecodeURIComponent(fileName) : undefined,
    // Omitted rather than sent as `false` so an older resolver, which does not
    // know the field, receives a byte-identical request to the one it does today.
    ...(canRequestDirect ? { direct: true } : {}),
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (canRequestDirect) {
    // Bearer replaces, not supplements, the Basic header — there is one
    // Authorization header. The Basic credential is not validated on /resolve
    // anyway (the ingress routes this path around the basic-auth middleware), so
    // nothing that works today stops working.
    headers['Authorization'] = `Bearer ${storageResolverInternalToken}`;
  } else if (storageResolverAuth) {
    headers['Authorization'] = `Basic ${Buffer.from(storageResolverAuth).toString('base64')}`;
  }

  const response = await fetch(`${storageResolverEndpoint}/resolve`, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new StorageResolverError(response.status, errorText);
  }

  const result = await response.json();
  return {
    url: result.url,
    urlExpiryDate: new Date(result.urlExpiryDate),
  };
}

/**
 * Statuses that positively assert the object is not there — 404 and 410 only.
 *
 * 410 is included to match the download endpoint, which has always treated
 * `404 || 410` as "the key doesn't resolve to a stored file"
 * (`src/pages/api/download/[...key].ts`) — a handling decision that predates this
 * code. Whether the delivery worker actually EMITS a 410 is not established in
 * this repo (it is a Cloudflare Worker whose source lives elsewhere), so treat
 * 410 as defensive parity, not as an observed case.
 */
const ABSENCE_STATUSES = new Set([404, 410]);

/**
 * Did this resolution failure prove the file is not there, as opposed to proving
 * only that we could not ask?
 *
 * Deliberately narrow: only the statuses in `ABSENCE_STATUSES` count, and when the
 * storage resolver was consulted it must be the one that said so. A caller acting
 * on `true` writes a permanent tombstone that also permanently exempts the file
 * from virus/pickle scanning, so the asymmetry matters — a wrongly-`true` answer
 * silently leaves a public file unscanned forever, while a wrongly-`false` answer
 * costs one retry on the next tick.
 *
 * 400 (malformed key) is NOT included even though such keys are genuinely
 * unresolvable: 400 is also what a transiently-misbehaving upstream returns, and
 * the malformed-key population is separately identifiable from the stored `url`
 * itself. Anything without a status (transport reject, config error, timeout) is
 * likewise not proof of absence.
 */
export function isDefiniteNotFound(err: unknown): boolean {
  // Note: unreachable from the scan pre-flight today — `resolveDownloadUrl` always
  // falls through to the delivery worker, so a StorageResolverError never escapes
  // it. Kept so the predicate is correct for any direct caller of
  // `getDownloadUrlByFileId`.
  if (err instanceof StorageResolverError) return ABSENCE_STATUSES.has(err.statusCode);

  if (err instanceof DeliveryWorkerError) {
    if (!ABSENCE_STATUSES.has(err.statusCode)) return false;
    // The resolver was consulted first and also failed. Its answer decides: only
    // the resolver can locate a file registered in `file_locations`, so unless IT
    // reported absence, this is "the legacy path can't see it", not "gone".
    //
    // 🔴 `!== undefined`, NOT an `instanceof` narrowing. A resolver that fails at
    // the TRANSPORT layer (connection refused, DNS, TCP timeout — what a pod
    // outage actually looks like) throws a TypeError, not a StorageResolverError.
    // Narrowing the guard would leave that unattached and fall through to
    // `return true`, tombstoning the file: precisely the bug this exists to stop.
    if (err.resolverError !== undefined) {
      return (
        err.resolverError instanceof StorageResolverError &&
        ABSENCE_STATUSES.has(err.resolverError.statusCode)
      );
    }
    // Reached when the resolver was not CONSULTED at all — the disabled path, or
    // a direct `getDownloadUrl` caller. (It cannot mean "the resolver succeeded":
    // `resolveDownloadUrl` returns on success rather than reaching the fallback.)
    // The delivery worker was then the only authority, and it said not-there.
    return true;
  }

  return false;
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
  fileName?: string,
  options?: ResolveOptions
): Promise<DownloadInfo> {
  if (isStorageResolverEnabled()) {
    let resolverError: unknown;
    try {
      return await getDownloadUrlByFileId(fileId, fileName, options);
    } catch (err) {
      // Fall back to delivery worker when the storage resolver doesn't have
      // this file (e.g. File table records like BountyEntry attachments that
      // aren't synced to file_locations). The fallback must still happen on a
      // resolver 404 — that is its whole purpose — so we cannot short-circuit
      // here. But we must not DISCARD the resolver's answer either: keep it and
      // attach it below, so a caller can tell "both said absent" from "the
      // resolver was down and the legacy path simply can't see this file".
      resolverError = err;
    }
    try {
      return await getDownloadUrl(fileUrl, fileName);
    } catch (deliveryWorkerError) {
      if (deliveryWorkerError instanceof DeliveryWorkerError) {
        deliveryWorkerError.resolverError = resolverError;
      }
      throw deliveryWorkerError;
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
