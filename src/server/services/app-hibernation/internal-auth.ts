import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request signing for `/api/internal/app-hibernation/*`, the routes the sandbox service calls.
 *
 * The caller sends two headers:
 *   x-hibernation-timestamp  unix seconds
 *   x-hibernation-signature  `v1=` + hex HMAC-SHA256(secret, canonical string)
 * and the canonical string is
 *   v1 \n METHOD \n PATH \n TIMESTAMP \n hex sha256(raw body)
 * PATH is the route's own path (no query), so a signature for one route is refused by another.
 *
 * A request is accepted only when the signature matches and the timestamp is within
 * {@link SIGNATURE_WINDOW_SECONDS} of now, as the repo's other signed internal callbacks do. A
 * request replayed inside the window repeats a call that is idempotent anyway: a retried `begin`
 * answers the same keys, and a retried `commit` the same receipt.
 */

export const SIGNATURE_WINDOW_SECONDS = 300;

export const HIBERNATION_HEADERS = {
  timestamp: 'x-hibernation-timestamp',
  signature: 'x-hibernation-signature',
} as const;

export function canonicalRequest(args: {
  method: string;
  path: string;
  timestamp: string;
  body: Buffer;
}): string {
  const bodyHash = createHash('sha256').update(new Uint8Array(args.body)).digest('hex');
  return ['v1', args.method.toUpperCase(), args.path, args.timestamp, bodyHash].join('\n');
}

/** The header value a caller holding `secret` sends. Exported for the tests and the caller's spec. */
export function signHibernationRequest(
  secret: string,
  args: { method: string; path: string; timestamp: string; body: Buffer }
): string {
  return `v1=${createHmac('sha256', secret.trim()).update(canonicalRequest(args)).digest('hex')}`;
}

export type HibernationAuthResult =
  | { ok: true }
  | { ok: false; status: 401; code: 'unauthorized' | 'stale' };

function header(headers: Record<string, string | string[] | undefined>, name: string) {
  const v = headers[name];
  return Array.isArray(v) ? undefined : v;
}

function sameSignature(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

/** Verifies a signed request: the signature first, then the timestamp window. */
export function verifyHibernationRequest(args: {
  secret: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  nowSeconds: number;
}): HibernationAuthResult {
  const timestamp = header(args.headers, HIBERNATION_HEADERS.timestamp);
  const signature = header(args.headers, HIBERNATION_HEADERS.signature);
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp))
    return { ok: false, status: 401, code: 'unauthorized' };

  const expected = signHibernationRequest(args.secret, {
    method: args.method,
    path: args.path,
    timestamp,
    body: args.body,
  });
  if (!sameSignature(signature, expected)) return { ok: false, status: 401, code: 'unauthorized' };

  if (Math.abs(args.nowSeconds - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS)
    return { ok: false, status: 401, code: 'stale' };
  return { ok: true };
}
