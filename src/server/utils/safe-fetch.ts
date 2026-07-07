import { lookup } from 'node:dns/promises';

import { isPrivateIp, isPublicHttpsUrl } from '~/server/utils/ssrf-hostname';

/**
 * SSRF-hardened server-side fetch — the ONE guarded outbound-fetch primitive for
 * pulling an attacker-influenced URL (an App Blocks external-listing page or its
 * og:image). There is NO existing safeFetch/isPrivateIp util in the repo; this is
 * it. `unfurl.js` and `cf-images-utils.uploadViaBuffer` both do UNGUARDED outbound
 * fetches — do NOT use them to reach a user-supplied URL; use this instead.
 *
 * Controls (all enforced on every hop):
 *   1. LEXICAL — https-only + `isPublicHttpsUrl` (rejects hex/int/octal IPv4,
 *      IPv4-mapped IPv6, dot-less/reserved hosts) AND reject URL userinfo
 *      (`user:pass@host`).
 *   2. DNS — resolve the host to ALL A/AAAA addresses and reject if ANY resolves
 *      to a private/loopback/link-local/unique-local/metadata range. This closes
 *      the DNS-rebinding hole the lexical guard can't see.
 *   3. REDIRECTS — `redirect: 'manual'`; a 3xx `Location` is followed at most
 *      `maxRedirects` (default 2) hops, and EACH hop's host is re-validated
 *      (lexical + DNS) before it is fetched.
 *   4. TIMEOUT — a hard `AbortSignal.timeout` per request.
 *   5. SIZE — a hard `maxBytes` cap, enforced by the `Content-Length` header
 *      (pre-buffer) AND by aborting mid-stream once the cumulative body exceeds it.
 *   6. CONTENT-TYPE — a per-call allowlist (text/html for the page; image/* for
 *      the image), matched by prefix on the final response.
 */

export type SafeFetchErrorCode =
  | 'invalid_url' // lexical reject (non-https, bad host shape, userinfo)
  | 'blocked_host' // DNS resolved to a private/reserved address
  | 'dns_failure' // host didn't resolve
  | 'too_many_redirects'
  | 'bad_status' // non-2xx (and non-followed-3xx) response
  | 'content_type' // response content-type not in the allowlist
  | 'too_large' // body exceeded maxBytes
  | 'timeout' // aborted by the per-request timeout
  | 'network'; // any other transport error

/** A typed, NON-leaky failure. `message` is safe to log; never surface it raw to a client. */
export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

export type SafeFetchOptions = {
  /** Per-request timeout in ms (also the whole-chain budget per hop). */
  timeoutMs: number;
  /** Hard cap on the response body; the stream is aborted once it is exceeded. */
  maxBytes: number;
  /**
   * Allowed response content-type PREFIXES (matched on the `type/subtype` part,
   * lowercased, before any `;` params). e.g. `['text/html']` or `['image/']`.
   */
  allowedContentTypes: readonly string[];
  /** Max redirect hops to follow (each re-validated). Default 2. */
  maxRedirects?: number;
};

export type SafeFetchResult = {
  /** The FINAL URL fetched (after any followed redirects) — resolve relative assets against this. */
  finalUrl: string;
  /** The response content-type's `type/subtype` (lowercased, no params). */
  contentType: string;
  /** The fetched body bytes (≤ maxBytes). */
  bytes: Buffer;
};

/** Lexical + userinfo validation of a single URL. Throws SafeFetchError on reject. */
function assertLexicallySafe(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SafeFetchError('invalid_url', `unparseable URL`);
  }
  // Reject credentials in the URL (`https://example.com@evil.com`,
  // `https://user:pass@host`) — a display-vs-real-host phishing/SSRF vector.
  if (parsed.username || parsed.password) {
    throw new SafeFetchError('invalid_url', 'URL must not contain credentials (user:pass@host)');
  }
  const lexical = isPublicHttpsUrl(raw);
  if (!lexical.ok) throw new SafeFetchError('invalid_url', lexical.reason);
  return parsed;
}

/** DNS-resolve a host to all A/AAAA addresses and reject if ANY is private. */
async function assertHostResolvesPublic(hostname: string): Promise<void> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new SafeFetchError('dns_failure', `could not resolve host`);
  }
  if (addresses.length === 0) {
    throw new SafeFetchError('dns_failure', `host resolved to no addresses`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new SafeFetchError('blocked_host', `host resolves to a non-public address`);
    }
  }
}

/** Parse a `Content-Type` header down to its lowercased `type/subtype`. */
function normalizeContentType(raw: string | null): string {
  return (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function contentTypeAllowed(ct: string, allowed: readonly string[]): boolean {
  return allowed.some((prefix) => ct.startsWith(prefix.toLowerCase()));
}

/** Read a response body into a Buffer, aborting once `maxBytes` is exceeded. */
async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer> {
  // Pre-buffer guard: an advertised oversize body is rejected before reading.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SafeFetchError('too_large', `Content-Length ${declared} exceeds cap ${maxBytes}`);
  }

  const body = res.body;
  if (!body) {
    // No stream (e.g. a mocked/empty body) — fall back to arrayBuffer with a
    // post-read cap.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new SafeFetchError('too_large', `body exceeds cap ${maxBytes}`);
    }
    return buf;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new SafeFetchError('too_large', `body exceeds cap ${maxBytes}`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

/**
 * Perform an SSRF-hardened GET. Validates (lexical + DNS) the URL and every
 * redirect hop, enforces the timeout / size / content-type controls, and returns
 * the final URL + content-type + capped body bytes. Throws {@link SafeFetchError}
 * (a typed, non-leaky failure) on any control violation or transport error.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 2;
  let currentUrl = url;

  for (let hop = 0; ; hop++) {
    const parsed = assertLexicallySafe(currentUrl);
    await assertHostResolvesPublic(parsed.hostname);

    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          // A neutral UA + explicit Accept keeps some origins from serving a
          // login/redirect wall; harmless if ignored.
          'user-agent': 'CivitaiBot/1.0 (+https://civitai.com)',
          accept: opts.allowedContentTypes.join(', ') || '*/*',
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new SafeFetchError('timeout', 'request timed out');
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SafeFetchError('timeout', 'request aborted');
      }
      throw new SafeFetchError('network', 'transport error');
    }

    // Manual redirect handling: re-validate the Location host on the next hop.
    if (res.status >= 300 && res.status < 400) {
      // Free the redirect response's socket before following.
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location) throw new SafeFetchError('bad_status', `redirect without a Location`);
      if (hop >= maxRedirects) {
        throw new SafeFetchError('too_many_redirects', `exceeded ${maxRedirects} redirects`);
      }
      // Resolve a possibly-relative Location against the current URL, then loop
      // (the top of the loop re-runs the lexical + DNS guard on it).
      let next: string;
      try {
        next = new URL(location, parsed).toString();
      } catch {
        throw new SafeFetchError('invalid_url', 'malformed redirect Location');
      }
      currentUrl = next;
      continue;
    }

    if (!res.ok) {
      // Drain to free the socket, then reject.
      await res.body?.cancel().catch(() => undefined);
      throw new SafeFetchError('bad_status', `non-2xx status ${res.status}`);
    }

    const contentType = normalizeContentType(res.headers.get('content-type'));
    if (!contentTypeAllowed(contentType, opts.allowedContentTypes)) {
      await res.body?.cancel().catch(() => undefined);
      throw new SafeFetchError('content_type', `disallowed content-type "${contentType}"`);
    }

    const bytes = await readCappedBody(res, opts.maxBytes);
    return { finalUrl: parsed.toString(), contentType, bytes };
  }
}
