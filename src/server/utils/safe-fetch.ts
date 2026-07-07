import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

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
 *      to a private/loopback/link-local/unique-local/metadata range.
 *   3. CONNECTION PINNING (closes the DNS-rebinding TOCTOU) — the outbound socket
 *      is pinned to the EXACT validated IP via a per-request `lookup` override on
 *      `https.request`. Node's own connect path calls our `lookup`, which returns
 *      the address we validated in step 2 — so the byte we validated IS the byte
 *      we connect to. There is NO second, undici/OS resolution of the
 *      attacker-controlled name at connect time to race (the classic
 *      validate-then-`fetch(url)` TOCTOU, where an authoritative TTL-0 server can
 *      answer PUBLIC to the check and PRIVATE to the connect). SNI + the `Host`
 *      header still carry the real hostname (Node derives both from `hostname`,
 *      not from the pinned IP), so TLS cert validation is against the hostname.
 *   4. REDIRECTS — followed MANUALLY at most `maxRedirects` (default 2) hops; each
 *      hop re-runs the FULL lexical + DNS guard AND re-pins to that hop's freshly
 *      validated IP before any socket is opened to it (a redirect to a private
 *      host is rejected before it is ever connected).
 *   5. TIMEOUT — a hard per-request deadline (an AbortController fired by a timer)
 *      covering connect + headers + the whole body read.
 *   6. SIZE — a hard `maxBytes` cap, enforced by the `Content-Length` header
 *      (pre-buffer) AND by destroying the response stream once the cumulative body
 *      exceeds it.
 *   7. CONTENT-TYPE — a per-call allowlist (text/html for the page; image/* for
 *      the image), matched by prefix on the final response.
 *
 * No cookies, credentials, or auth headers are ever sent (no cookie jar; only a
 * neutral UA + Accept), so a redirect can't be used to exfiltrate ambient creds.
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
  /** Hard cap on the response body; the stream is destroyed once it is exceeded. */
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

/** A DNS-resolved, SSRF-validated address the socket is pinned to. */
type ValidatedAddress = { address: string; family: number };

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

/**
 * DNS-resolve a host to all A/AAAA addresses, reject if ANY is private, and return
 * the FIRST validated address to pin the outbound socket to. Every returned
 * address has been checked, so pinning to any one of them is safe; pinning is what
 * closes the rebinding TOCTOU (the connect path can't re-resolve to a private IP).
 */
async function resolveAndValidateHost(hostname: string): Promise<ValidatedAddress> {
  let addresses: ValidatedAddress[];
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
  return addresses[0];
}

/**
 * A `lookup` override that ALWAYS yields the pre-validated address, so Node's
 * connect path can never re-resolve the attacker-controlled name to a private IP.
 * Handles both callback conventions: `all: true` (array — Node ≥18 happy-eyeballs)
 * and the single-address form.
 */
function pinnedLookup(validated: ValidatedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: validated.address, family: validated.family }]);
    } else {
      callback(null, validated.address, validated.family);
    }
  };
}

/** Parse a `Content-Type` header down to its lowercased `type/subtype`. */
function normalizeContentType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function contentTypeAllowed(ct: string, allowed: readonly string[]): boolean {
  return allowed.some((prefix) => ct.startsWith(prefix.toLowerCase()));
}

/** Read a single header value (first, if a multi-value array). */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

type Hop = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
};

/**
 * Open ONE https GET to `parsed`, pinned to `validated`. Resolves once the
 * response headers are in (the body stream is returned unread). The `signal`
 * (a timeout deadline) aborts the request at any stage.
 */
function requestHop(
  parsed: URL,
  validated: ValidatedAddress,
  opts: SafeFetchOptions,
  signal: AbortSignal
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const req = https.request(
      {
        protocol: 'https:',
        // Real hostname → drives the Host header, SNI, and cert identity check.
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        // Pin the socket to the validated IP — the crux of the TOCTOU fix.
        lookup: pinnedLookup(validated),
        signal,
        headers: {
          // A neutral UA + explicit Accept keeps some origins from serving a
          // login/redirect wall; harmless if ignored. NO cookie / auth headers.
          'user-agent': 'CivitaiBot/1.0 (+https://civitai.com)',
          accept: opts.allowedContentTypes.join(', ') || '*/*',
        },
      },
      (res) => {
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, stream: res });
      }
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/** Map a raw transport error to a typed, non-leaky SafeFetchError. */
function mapTransportError(err: unknown): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err.name === 'AbortError' || err.name === 'TimeoutError' || code === 'ABORT_ERR') {
      return new SafeFetchError('timeout', 'request timed out');
    }
  }
  return new SafeFetchError('network', 'transport error');
}

/**
 * Read a response stream into a Buffer, destroying it once `maxBytes` is exceeded
 * or the deadline `signal` fires. The `Content-Length` header (when present +
 * oversize) short-circuits before a byte is read.
 */
function readCappedBody(
  stream: IncomingMessage,
  contentLength: string | undefined,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    stream.destroy();
    return Promise.reject(
      new SafeFetchError('too_large', `Content-Length ${declared} exceeds cap ${maxBytes}`)
    );
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    const fail = (e: SafeFetchError) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(e);
    };
    const onAbort = () => fail(new SafeFetchError('timeout', 'request timed out'));
    const onData = (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        fail(new SafeFetchError('too_large', `body exceeds cap ${maxBytes}`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(mapTransportError(err));
    };

    if (signal.aborted) {
      fail(new SafeFetchError('timeout', 'request timed out'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/** Discard a response body (free the socket) without reading it into memory. */
function drain(stream: IncomingMessage): void {
  stream.destroy();
}

/**
 * Perform an SSRF-hardened GET. Validates (lexical + DNS) the URL and every
 * redirect hop, PINS the outbound socket to the validated IP (closing the
 * DNS-rebinding TOCTOU), enforces the timeout / size / content-type controls, and
 * returns the final URL + content-type + capped body bytes. Throws
 * {@link SafeFetchError} (a typed, non-leaky failure) on any control violation or
 * transport error.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 2;
  let currentUrl = url;

  for (let hop = 0; ; hop++) {
    const parsed = assertLexicallySafe(currentUrl);
    const validated = await resolveAndValidateHost(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      let res: Hop;
      try {
        res = await requestHop(parsed, validated, opts, controller.signal);
      } catch (err) {
        throw mapTransportError(err);
      }

      // Manual redirect handling: re-validate + re-pin the Location host next hop.
      if (res.statusCode >= 300 && res.statusCode < 400) {
        drain(res.stream); // free the redirect response's socket before following.
        const location = headerValue(res.headers, 'location');
        if (!location) throw new SafeFetchError('bad_status', `redirect without a Location`);
        if (hop >= maxRedirects) {
          throw new SafeFetchError('too_many_redirects', `exceeded ${maxRedirects} redirects`);
        }
        // Resolve a possibly-relative Location against the current URL, then loop
        // (the top of the loop re-runs the lexical + DNS + pin guard on it).
        let next: string;
        try {
          next = new URL(location, parsed).toString();
        } catch {
          throw new SafeFetchError('invalid_url', 'malformed redirect Location');
        }
        currentUrl = next;
        continue;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        drain(res.stream);
        throw new SafeFetchError('bad_status', `non-2xx status ${res.statusCode}`);
      }

      const contentType = normalizeContentType(headerValue(res.headers, 'content-type'));
      if (!contentTypeAllowed(contentType, opts.allowedContentTypes)) {
        drain(res.stream);
        throw new SafeFetchError('content_type', `disallowed content-type "${contentType}"`);
      }

      const bytes = await readCappedBody(
        res.stream,
        headerValue(res.headers, 'content-length'),
        opts.maxBytes,
        controller.signal
      );
      return { finalUrl: parsed.toString(), contentType, bytes };
    } finally {
      clearTimeout(timer);
    }
  }
}
