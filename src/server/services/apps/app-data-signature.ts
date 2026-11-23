// The caller check of the document store's INTERNAL route (apps/app-data-go/WRITES-DESIGN.md,
// "The internal route", steps 1 to 3): the route app-data-go forwards writes to. It runs on the
// same public-facing site processes as every other route, so a network policy cannot single it
// out; this signature is what keeps apps off it. It authenticates the CALLER (app-data-go) only and
// confers no user or app authority: the user's token is still verified by the block-token
// middleware and judged by the storage handler, exactly as on the public route.
//
// Pure: no env, no database. `doc-store-internal-route.ts` wires it with the key and the store's
// body limit.
//
// THE SCHEME. `x-app-data-ts` is unix seconds; `x-app-data-sig` is the lowercase hex
// HMAC-SHA256, under a key only app-data-go and the site hold, of five lines joined by `\n`:
//   1. the method;
//   2. the request path exactly as sent (no decoding or normalisation);
//   3. the full raw query string, without the `?` (empty when there is none);
//   4. the timestamp, as sent;
//   5. the lowercase hex SHA-256 of the raw body (of zero bytes when there is none).
// A timestamp more than 60 s from this clock, or a mismatch, is a 401 and nothing else runs.
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

export const APP_DATA_TS_HEADER = 'x-app-data-ts';
export const APP_DATA_SIG_HEADER = 'x-app-data-sig';

/** How far a signed timestamp may be from this clock, either way, in seconds (inclusive). */
export const APP_DATA_SIGNATURE_WINDOW_SECONDS = 60;

/** The SHA-256 of zero bytes: the body line of a request with no body. */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export type AppDataSignedParts = {
  method: string;
  /** The path as sent, `?` and query excluded. */
  path: string;
  /** The raw query string as sent, without the `?`; empty when there is none. */
  query: string;
  /** The timestamp exactly as sent in `x-app-data-ts`. */
  timestamp: string;
  body: Buffer;
};

export function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The five signed lines, joined by `\n` (no trailing newline). */
export function appDataCanonicalString(parts: AppDataSignedParts): string {
  return [parts.method, parts.path, parts.query, parts.timestamp, sha256Hex(parts.body)].join('\n');
}

export function signAppDataRequest(key: string, parts: AppDataSignedParts): string {
  return createHmac('sha256', key).update(appDataCanonicalString(parts)).digest('hex');
}

/** A raw request target split into its path and its raw query, neither decoded. */
export function splitRequestTarget(rawUrl: string): { path: string; query: string } {
  const q = rawUrl.indexOf('?');
  return q < 0
    ? { path: rawUrl, query: '' }
    : { path: rawUrl.slice(0, q), query: rawUrl.slice(q + 1) };
}

export type AppDataSignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

const TIMESTAMP_RE = /^[0-9]{1,12}$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

/** The header checks that need no body: presence, shape and the replay window. */
export function checkAppDataHeaders(
  timestamp: string | undefined,
  signature: string | undefined,
  nowSeconds: number
): AppDataSignatureVerdict {
  if (timestamp === undefined || signature === undefined) return { ok: false, reason: 'missing' };
  if (!TIMESTAMP_RE.test(timestamp) || !SIGNATURE_RE.test(signature)) {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > APP_DATA_SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true };
}

/** The whole check: the headers, then the HMAC over the request as received. Constant-time. */
export function verifyAppDataSignature(input: {
  key: string;
  method: string;
  rawUrl: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: Buffer;
  nowSeconds: number;
}): AppDataSignatureVerdict {
  const headers = checkAppDataHeaders(input.timestamp, input.signature, input.nowSeconds);
  if (!headers.ok) return headers;
  const { path, query } = splitRequestTarget(input.rawUrl);
  const expected = Buffer.from(
    signAppDataRequest(input.key, {
      method: input.method,
      path,
      query,
      timestamp: input.timestamp as string,
      body: input.body,
    }),
    'hex'
  );
  const given = Buffer.from(input.signature as string, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

function header(req: NextApiRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/** The storage envelope (`doc-store-api.ts`), for the few answers given before the handler runs. */
function refuse(res: NextApiResponse, status: number, code: string, message: string): void {
  res.status(status).json({ code, message, error: message });
}

/** The body stopped arriving, or was larger than the limit. */
class BodyReadError extends Error {
  constructor(readonly tooLarge: boolean) {
    super(tooLarge ? 'too large' : 'aborted');
  }
}

async function readRawBody(req: NextApiRequest, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyReadError(true);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) throw new BodyReadError(true);
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof BodyReadError) throw err;
    throw new BodyReadError(false);
  }
  return Buffer.concat(chunks);
}

/**
 * Hands the handler the bytes that were signed, as the request stream: the storage handler's
 * `readJsonBody` iterates the request, which is now already drained, so its async iterator is
 * replaced on this request object with one that yields the buffered body once.
 */
function reinjectBody(req: NextApiRequest, body: Buffer): void {
  Object.defineProperty(req, Symbol.asyncIterator, {
    configurable: true,
    value: async function* () {
      if (body.length > 0) yield body;
    },
  });
}

export type AppDataSignatureOpts = {
  /** The HMAC key, read per request. Unset or empty: the route does not exist (404). */
  signingKey: () => string | undefined;
  /** The internal route's path prefix, as received (`/api/internal/blocks/storage`). */
  internalPrefix: string;
  /** The public route's path prefix the chain must see (`/api/v1/blocks/storage`). */
  publicPrefix: string;
  /** The largest body read (the store's `STORAGE_BODY_LIMIT_BYTES`); over it a 413. */
  bodyLimit: number;
  /** Unix seconds. Injectable for the replay-window tests. */
  now?: () => number;
};

/**
 * The internal route's front: the signature before anything else, the body buffered once, then
 * `req.url` rewritten to the public path so the wrapped chain (the block-token middleware's audit
 * row and the handler's routing) sees the same request a direct call would. It never sets
 * `blockClaims`: only the block-token middleware does, after verifying the user's token.
 */
export function withAppDataSignature(handler: NextApiHandler, opts: AppDataSignatureOpts) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return async function appDataSignedRoute(req: NextApiRequest, res: NextApiResponse) {
    const key = opts.signingKey();
    if (!key) {
      refuse(res, 404, 'not_found', 'no such storage route');
      return;
    }
    const rawUrl = req.url ?? '';
    const { path, query } = splitRequestTarget(rawUrl);
    if (path !== opts.internalPrefix && !path.startsWith(`${opts.internalPrefix}/`)) {
      refuse(res, 404, 'not_found', 'no such storage route');
      return;
    }
    const timestamp = header(req, APP_DATA_TS_HEADER);
    const signature = header(req, APP_DATA_SIG_HEADER);
    // The checks that need no body first, so an unsigned caller is refused before anything is read.
    if (!checkAppDataHeaders(timestamp, signature, now()).ok) {
      refuse(res, 401, 'unauthenticated', 'invalid service signature');
      return;
    }
    let body: Buffer;
    try {
      body = await readRawBody(req, opts.bodyLimit);
    } catch (err) {
      if (err instanceof BodyReadError && err.tooLarge) {
        refuse(res, 413, 'too_large', `request body exceeds ${opts.bodyLimit} bytes`);
      } else if (!req.destroyed && !res.destroyed && !res.writableEnded) {
        refuse(res, 400, 'invalid_request', 'request body was not received');
      }
      return;
    }
    const verdict = verifyAppDataSignature({
      key,
      method: req.method ?? '',
      rawUrl,
      timestamp,
      signature,
      body,
      nowSeconds: now(),
    });
    if (!verdict.ok) {
      refuse(res, 401, 'unauthenticated', 'invalid service signature');
      return;
    }
    reinjectBody(req, body);
    req.url = `${opts.publicPrefix}${path.slice(opts.internalPrefix.length)}${
      query ? `?${query}` : ''
    }`;
    return handler(req, res);
  };
}
