import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request signing for `/api/internal/app-hibernation/*`, the routes the sandbox service calls.
 *
 * The caller sends three headers:
 *   x-hibernation-timestamp  unix seconds
 *   x-hibernation-nonce      16-128 characters of [A-Za-z0-9_-], new for every request
 *   x-hibernation-signature  `v1=` + hex HMAC-SHA256(secret, canonical string)
 * and the canonical string is
 *   v1 \n METHOD \n PATH \n TIMESTAMP \n NONCE \n hex sha256(raw body)
 * PATH is the route's own path (no query), so a signature for one route is refused by another.
 *
 * A request is accepted only when the signature matches, the timestamp is within
 * {@link SIGNATURE_WINDOW_SECONDS} of now, and the nonce has not been seen before. The nonce is
 * claimed only after the signature checks out (so nobody can burn nonces), and is remembered for
 * twice the window, longer than any timestamp it could be replayed with is accepted.
 */

export const SIGNATURE_WINDOW_SECONDS = 300;
export const NONCE_TTL_SECONDS = SIGNATURE_WINDOW_SECONDS * 2;

export const HIBERNATION_HEADERS = {
  timestamp: 'x-hibernation-timestamp',
  nonce: 'x-hibernation-nonce',
  signature: 'x-hibernation-signature',
} as const;

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function canonicalRequest(args: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: Buffer;
}): string {
  const bodyHash = createHash('sha256').update(new Uint8Array(args.body)).digest('hex');
  return ['v1', args.method.toUpperCase(), args.path, args.timestamp, args.nonce, bodyHash].join(
    '\n'
  );
}

/** The header value a caller holding `secret` sends. Exported for the tests and the caller's spec. */
export function signHibernationRequest(
  secret: string,
  args: { method: string; path: string; timestamp: string; nonce: string; body: Buffer }
): string {
  return `v1=${createHmac('sha256', secret.trim()).update(canonicalRequest(args)).digest('hex')}`;
}

export type HibernationAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; code: 'unauthorized' | 'stale' | 'replay' | 'unavailable' };

function header(headers: Record<string, string | string[] | undefined>, name: string) {
  const v = headers[name];
  return Array.isArray(v) ? undefined : v;
}

function sameSignature(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

/**
 * Verifies a signed request. `claimNonce` must atomically record the nonce and answer `true` only
 * the first time it is seen; when it throws (its store is down) the request is refused with 503
 * rather than accepted unchecked.
 */
export async function verifyHibernationRequest(args: {
  secret: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  nowSeconds: number;
  claimNonce: (nonce: string, ttlSeconds: number) => Promise<boolean>;
}): Promise<HibernationAuthResult> {
  const timestamp = header(args.headers, HIBERNATION_HEADERS.timestamp);
  const nonce = header(args.headers, HIBERNATION_HEADERS.nonce);
  const signature = header(args.headers, HIBERNATION_HEADERS.signature);
  if (!timestamp || !nonce || !signature || !/^\d{1,12}$/.test(timestamp) || !NONCE_RE.test(nonce))
    return { ok: false, status: 401, code: 'unauthorized' };

  const expected = signHibernationRequest(args.secret, {
    method: args.method,
    path: args.path,
    timestamp,
    nonce,
    body: args.body,
  });
  if (!sameSignature(signature, expected)) return { ok: false, status: 401, code: 'unauthorized' };

  if (Math.abs(args.nowSeconds - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS)
    return { ok: false, status: 401, code: 'stale' };

  let fresh: boolean;
  try {
    fresh = await args.claimNonce(nonce, NONCE_TTL_SECONDS);
  } catch {
    return { ok: false, status: 503, code: 'unavailable' };
  }
  if (!fresh) return { ok: false, status: 401, code: 'replay' };
  return { ok: true };
}
