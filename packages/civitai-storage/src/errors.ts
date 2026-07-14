// Pure classification of an S3/AWS-SDK error thrown while finalizing (complete) or aborting a
// multipart upload, so a handler can map it to the RIGHT HTTP status instead of a blind 500. Ported
// from the monolith's s3-utils so the storage service (which now issues the complete/abort .send())
// and any consumer classify identically. No SDK/env deps.
//
//  - not-found     — the upload no longer exists (already completed/aborted; a client double-submit).
//                    AWS-SDK v3 → `NoSuchUpload` / HTTP 404. Terminal; retrying is futile.
//  - invalid-parts — the parts manifest doesn't match / is empty / mis-ordered / malformed. AWS-SDK v3 →
//                    `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall`/`MalformedXML`/`InvalidRequest`,
//                    all HTTP 400. Terminal; the client must re-upload.
//  - transient     — retry-able backend blip: S3/B2 5xx, a throttle/timing signal, or a network failure.
//  - other         — anything unrecognized (incl. a genuine server bug); surface as a hard 500.
export type S3MultipartErrorClass = 'not-found' | 'invalid-parts' | 'transient' | 'other';

const TRANSIENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'SlowDown',
  'RequestTimeout',
  'RequestTimeTooSkewed',
  'ServiceUnavailable',
  'InternalError',
]);

const INVALID_PARTS_ERROR_NAMES: ReadonlySet<string> = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'MalformedXML',
]);

const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

// True for a status-less network failure (pre-response). Walks the `.cause` chain — undici nests the
// syscall error under `TypeError.cause`.
function isNetworkError(e: unknown): boolean {
  let cur = e as { message?: string; code?: string; cause?: unknown } | undefined;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if (typeof cur.code === 'string' && NETWORK_CODES.has(cur.code)) return true;
    const msg = typeof cur.message === 'string' ? cur.message : '';
    if (msg.includes('fetch failed') || msg.includes('terminated')) return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

export function classifyS3MultipartError(error: unknown): S3MultipartErrorClass {
  const err = error as
    | { name?: unknown; $metadata?: { httpStatusCode?: unknown } | null }
    | null
    | undefined;
  const name = typeof err?.name === 'string' ? err.name : undefined;
  const httpStatusCode =
    typeof err?.$metadata?.httpStatusCode === 'number' ? err.$metadata.httpStatusCode : undefined;

  if (name === 'NoSuchUpload' || httpStatusCode === 404) return 'not-found';

  if (name && INVALID_PARTS_ERROR_NAMES.has(name)) return 'invalid-parts';
  if (name === 'InvalidRequest' && httpStatusCode === 400) return 'invalid-parts';

  if (typeof httpStatusCode === 'number' && httpStatusCode >= 500) return 'transient';
  if (name && TRANSIENT_ERROR_NAMES.has(name)) return 'transient';
  if (isNetworkError(error)) return 'transient';

  return 'other';
}
