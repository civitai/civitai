import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DNS resolver AND the node:https transport the fetch-time guard uses;
// each test drives them. `node:https` is a default-import (`https.request`) in the
// module under test, so the mock exposes a `default`. `requestMock` is `vi.hoisted`
// so it exists when the hoisted `vi.mock` factory runs.
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ default: { request: requestMock } }));

import { lookup } from 'node:dns/promises';
import { SafeFetchError, safeFetch } from '~/server/utils/safe-fetch';

/**
 * SSRF-hardened fetch. Proves EVERY control: lexical (non-https, userinfo, IP
 * literal) reject, DNS-resolves-to-private reject, redirect-to-private reject,
 * redirect cap, size cap (header + mid-stream), content-type allowlist, non-2xx,
 * timeout — AND, critically, that the outbound SOCKET is PINNED to the validated
 * IP (the DNS-rebinding TOCTOU fix): the `lookup` override handed to
 * `https.request` yields the address `resolveAndValidateHost` validated, so a
 * public-then-private rebind can never land the connect on the private IP.
 * `https.request` + `node:dns` are mocked so the tests are pure + fast.
 */

const lookupMock = vi.mocked(lookup);

type FakeInit = { status?: number; headers?: Record<string, string>; chunks?: string[] };

/** A minimal IncomingMessage stand-in: a real Readable + statusCode/headers. */
function fakeResponse({ status = 200, headers = {}, chunks = [] as string[] }: FakeInit) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  const stream = Readable.from(chunks.map((c) => Buffer.from(c)));
  return Object.assign(stream, { statusCode: status, headers: lower });
}

/** The options passed to each `https.request` call (assert pinning on these). */
let capturedOptions: any[] = [];

/**
 * Drive the transport. `responses` is consumed one-per-hop; a value of `'hang'`
 * makes the request never respond (so the abort deadline fires — timeout test);
 * an `Error` is emitted on the request.
 */
function primeTransport(...responses: Array<ReturnType<typeof fakeResponse> | Error | 'hang'>) {
  let i = 0;
  requestMock.mockImplementation((options: any, cb: (res: unknown) => void) => {
    capturedOptions.push(options);
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const r = responses[i++];
      if (r === 'hang') {
        options.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          req.emit('error', e);
        });
        return;
      }
      if (r instanceof Error) {
        queueMicrotask(() => req.emit('error', r));
        return;
      }
      queueMicrotask(() => cb(r));
    };
    return req;
  });
}

beforeEach(() => {
  requestMock.mockReset();
  capturedOptions = [];
  lookupMock.mockReset();
  // Default: every host resolves to a single public address.
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const HTML = { timeoutMs: 5000, maxBytes: 1000, allowedContentTypes: ['text/html'] } as const;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '<<no-throw>>';
  } catch (e) {
    if (e instanceof SafeFetchError) return e.code;
    throw e;
  }
}

/** Invoke a captured `lookup` override and return the address(es) it yields. */
function invokeLookup(
  lookupFn: any,
  all: boolean
): { address: string; family: number } | Array<{ address: string; family: number }> {
  let out: any;
  lookupFn('ignored.example.com', { all }, (_err: unknown, a: unknown, family?: number) => {
    out = all ? a : { address: a, family };
  });
  return out;
}

describe('safeFetch — lexical rejects (no DNS / no request)', () => {
  it('rejects a non-https URL', async () => {
    expect(await code(safeFetch('http://example.com', HTML))).toBe('invalid_url');
    expect(requestMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects userinfo (user:pass@host)', async () => {
    expect(await code(safeFetch('https://user:pass@example.com', HTML))).toBe('invalid_url');
    expect(await code(safeFetch('https://example.com@evil.com', HTML))).toBe('invalid_url');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects an IP-literal host lexically', async () => {
    expect(await code(safeFetch('https://127.0.0.1', HTML))).toBe('invalid_url');
    expect(await code(safeFetch('https://2130706433', HTML))).toBe('invalid_url');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('safeFetch — DNS-resolve guard', () => {
  it('rejects when the host resolves to a private address (DNS-rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    expect(await code(safeFetch('https://rebind.example.com', HTML))).toBe('blocked_host');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects if ANY resolved address is private (mixed A records)', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ] as never);
    expect(await code(safeFetch('https://mixed.example.com', HTML))).toBe('blocked_host');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('maps a DNS failure to dns_failure', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await code(safeFetch('https://nxdomain.example.com', HTML))).toBe('dns_failure');
  });
});

describe('safeFetch — connection pinning (DNS-rebinding TOCTOU fix)', () => {
  it('pins the outbound socket to the validated IP; SNI/Host keep the hostname', async () => {
    lookupMock.mockResolvedValue([{ address: '203.0.113.7', family: 4 }] as never);
    primeTransport(
      fakeResponse({ headers: { 'content-type': 'text/html' }, chunks: ['ok'] })
    );
    await safeFetch('https://vendor.example.com/app', HTML);

    const opts = capturedOptions[0];
    // Host header + SNI + cert identity ride the real hostname, NOT the pinned IP.
    expect(opts.hostname).toBe('vendor.example.com');
    // The lookup override is what pins the socket — it yields ONLY the validated IP.
    expect(typeof opts.lookup).toBe('function');
    expect(invokeLookup(opts.lookup, true)).toEqual([{ address: '203.0.113.7', family: 4 }]);
    expect(invokeLookup(opts.lookup, false)).toEqual({ address: '203.0.113.7', family: 4 });
  });

  it('a public-then-private rebind cannot make the connect target the private IP', async () => {
    // Validation time: the authoritative server answers PUBLIC.
    lookupMock.mockResolvedValue([{ address: '198.51.100.9', family: 4 }] as never);
    primeTransport(
      fakeResponse({ headers: { 'content-type': 'text/html' }, chunks: ['ok'] })
    );
    await safeFetch('https://rebind.example.com', HTML);

    const opts = capturedOptions[0];
    // Connect time: even if DNS now flips to a private IP, Node calls OUR pinned
    // lookup, which returns ONLY the validated public IP — never 169.254.169.254.
    const all = invokeLookup(opts.lookup, true) as Array<{ address: string }>;
    expect(all.map((a) => a.address)).toEqual(['198.51.100.9']);
    expect(all.some((a) => a.address === '169.254.169.254')).toBe(false);
    expect(invokeLookup(opts.lookup, false)).toEqual({ address: '198.51.100.9', family: 4 });
  });
});

describe('safeFetch — response controls', () => {
  it('returns bytes + content-type + finalUrl on a good response', async () => {
    primeTransport(
      fakeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: ['<html>hi'] })
    );
    const r = await safeFetch('https://example.com/page', HTML);
    expect(r.contentType).toBe('text/html');
    expect(r.bytes.toString('utf8')).toBe('<html>hi');
    expect(r.finalUrl).toBe('https://example.com/page');
  });

  it('rejects a disallowed content-type', async () => {
    primeTransport(fakeResponse({ headers: { 'content-type': 'application/json' }, chunks: ['{}'] }));
    expect(await code(safeFetch('https://example.com', HTML))).toBe('content_type');
  });

  it('rejects a non-2xx status', async () => {
    primeTransport(fakeResponse({ status: 404 }));
    expect(await code(safeFetch('https://example.com', HTML))).toBe('bad_status');
  });

  it('rejects an oversize body via the Content-Length header (pre-buffer)', async () => {
    primeTransport(
      fakeResponse({ headers: { 'content-type': 'text/html', 'content-length': '999999' } })
    );
    expect(await code(safeFetch('https://example.com', { ...HTML, maxBytes: 100 }))).toBe(
      'too_large'
    );
  });

  it('aborts mid-stream once the body exceeds maxBytes (lying/absent Content-Length)', async () => {
    // No content-length; body is 12 bytes but the cap is 5.
    primeTransport(
      fakeResponse({ headers: { 'content-type': 'text/html' }, chunks: ['abcd', 'efgh', 'ijkl'] })
    );
    expect(await code(safeFetch('https://example.com', { ...HTML, maxBytes: 5 }))).toBe('too_large');
  });

  it('maps a request timeout (abort deadline) to timeout', async () => {
    primeTransport('hang');
    expect(await code(safeFetch('https://example.com', { ...HTML, timeoutMs: 20 }))).toBe('timeout');
  });

  it('maps a transport error to network', async () => {
    primeTransport(new Error('ECONNRESET'));
    expect(await code(safeFetch('https://example.com', HTML))).toBe('network');
  });
});

describe('safeFetch — redirects (re-validated + re-pinned per hop)', () => {
  it('re-validates a redirect Location and rejects one pointing at a private host', async () => {
    lookupMock.mockImplementation(async (host: string) =>
      host === 'internal.example.com'
        ? ([{ address: '10.1.2.3', family: 4 }] as never)
        : ([{ address: '93.184.216.34', family: 4 }] as never)
    );
    primeTransport(
      fakeResponse({ status: 302, headers: { location: 'https://internal.example.com/x' } })
    );
    expect(await code(safeFetch('https://example.com', HTML))).toBe('blocked_host');
    // Only the FIRST hop opened a socket; the private redirect target never did.
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to a public host, re-pinning to the new host IP', async () => {
    lookupMock.mockImplementation(async (host: string) =>
      host === 'www.example.com'
        ? ([{ address: '198.51.100.20', family: 4 }] as never)
        : ([{ address: '203.0.113.5', family: 4 }] as never)
    );
    primeTransport(
      fakeResponse({ status: 301, headers: { location: 'https://www.example.com/final' } }),
      fakeResponse({ headers: { 'content-type': 'text/html' }, chunks: ['final'] })
    );
    const r = await safeFetch('https://example.com', HTML);
    expect(r.finalUrl).toBe('https://www.example.com/final');
    expect(r.bytes.toString('utf8')).toBe('final');
    // Hop 1 pinned the origin IP; hop 2 re-pinned to the redirect target's IP.
    expect(capturedOptions[0].hostname).toBe('example.com');
    expect(invokeLookup(capturedOptions[0].lookup, false)).toEqual({ address: '203.0.113.5', family: 4 });
    expect(capturedOptions[1].hostname).toBe('www.example.com');
    expect(invokeLookup(capturedOptions[1].lookup, false)).toEqual({ address: '198.51.100.20', family: 4 });
  });

  it('caps the redirect chain', async () => {
    primeTransport(
      fakeResponse({ status: 302, headers: { location: 'https://example.com/loop' } }),
      fakeResponse({ status: 302, headers: { location: 'https://example.com/loop' } }),
      fakeResponse({ status: 302, headers: { location: 'https://example.com/loop' } }),
      fakeResponse({ status: 302, headers: { location: 'https://example.com/loop' } })
    );
    expect(await code(safeFetch('https://example.com', HTML))).toBe('too_many_redirects');
  });
});
