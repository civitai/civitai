import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DNS resolver the fetch-time guard uses; each test drives it.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

import { lookup } from 'node:dns/promises';
import { SafeFetchError, safeFetch } from '~/server/utils/safe-fetch';

/**
 * SSRF-hardened fetch. Proves EVERY control: lexical (non-https, userinfo, IP
 * literal) reject, DNS-resolves-to-private reject, redirect-to-private reject,
 * redirect cap, size cap (header + mid-stream), content-type allowlist, non-2xx,
 * and timeout. `fetch` + `node:dns` are mocked so the tests are pure + fast.
 */

const lookupMock = vi.mocked(lookup);

type FakeInit = { status?: number; headers?: Record<string, string>; chunks?: string[] };
/** A minimal Response stand-in exposing only what safeFetch touches. */
function fakeResponse({ status = 200, headers = {}, chunks = [] as string[] }: FakeInit) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  let i = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
              : { done: true, value: undefined },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        };
      },
      cancel: async () => undefined,
    },
    arrayBuffer: async () => new TextEncoder().encode(chunks.join('')).buffer,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  lookupMock.mockReset();
  // Default: every host resolves to a single public address.
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

describe('safeFetch — lexical rejects (no DNS / no fetch)', () => {
  it('rejects a non-https URL', async () => {
    expect(await code(safeFetch('http://example.com', HTML))).toBe('invalid_url');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects userinfo (user:pass@host)', async () => {
    expect(await code(safeFetch('https://user:pass@example.com', HTML))).toBe('invalid_url');
    expect(await code(safeFetch('https://example.com@evil.com', HTML))).toBe('invalid_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an IP-literal host lexically', async () => {
    expect(await code(safeFetch('https://127.0.0.1', HTML))).toBe('invalid_url');
    expect(await code(safeFetch('https://2130706433', HTML))).toBe('invalid_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('safeFetch — DNS-resolve guard', () => {
  it('rejects when the host resolves to a private address (DNS-rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    expect(await code(safeFetch('https://rebind.example.com', HTML))).toBe('blocked_host');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects if ANY resolved address is private (mixed A records)', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ] as never);
    expect(await code(safeFetch('https://mixed.example.com', HTML))).toBe('blocked_host');
  });

  it('maps a DNS failure to dns_failure', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await code(safeFetch('https://nxdomain.example.com', HTML))).toBe('dns_failure');
  });
});

describe('safeFetch — response controls', () => {
  it('returns bytes + content-type + finalUrl on a good response, using redirect:manual', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: ['<html>hi'] })
    );
    const r = await safeFetch('https://example.com/page', HTML);
    expect(r.contentType).toBe('text/html');
    expect(r.bytes.toString('utf8')).toBe('<html>hi');
    expect(r.finalUrl).toBe('https://example.com/page');
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('rejects a disallowed content-type', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ headers: { 'content-type': 'application/json' }, chunks: ['{}'] })
    );
    expect(await code(safeFetch('https://example.com', HTML))).toBe('content_type');
  });

  it('rejects a non-2xx status', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 404 }));
    expect(await code(safeFetch('https://example.com', HTML))).toBe('bad_status');
  });

  it('rejects an oversize body via the Content-Length header (pre-buffer)', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ headers: { 'content-type': 'text/html', 'content-length': '999999' } })
    );
    expect(await code(safeFetch('https://example.com', { ...HTML, maxBytes: 100 }))).toBe(
      'too_large'
    );
  });

  it('aborts mid-stream once the body exceeds maxBytes (lying/absent Content-Length)', async () => {
    // No content-length; body is 12 bytes but the cap is 5.
    fetchMock.mockResolvedValue(
      fakeResponse({ headers: { 'content-type': 'text/html' }, chunks: ['abcd', 'efgh', 'ijkl'] })
    );
    expect(await code(safeFetch('https://example.com', { ...HTML, maxBytes: 5 }))).toBe('too_large');
  });

  it('maps a fetch TimeoutError to timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    expect(await code(safeFetch('https://example.com', HTML))).toBe('timeout');
  });
});

describe('safeFetch — redirects (re-validated per hop)', () => {
  it('re-validates a redirect Location and rejects one pointing at a private host', async () => {
    lookupMock.mockImplementation(async (host: string) =>
      host === 'internal.example.com'
        ? ([{ address: '10.1.2.3', family: 4 }] as never)
        : ([{ address: '93.184.216.34', family: 4 }] as never)
    );
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 302, headers: { location: 'https://internal.example.com/x' } })
    );
    expect(await code(safeFetch('https://example.com', HTML))).toBe('blocked_host');
    // Only the FIRST hop was fetched; the private redirect target never was.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to a public host and returns the final body', async () => {
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse({ status: 301, headers: { location: 'https://www.example.com/final' } })
      )
      .mockResolvedValueOnce(
        fakeResponse({ headers: { 'content-type': 'text/html' }, chunks: ['final'] })
      );
    const r = await safeFetch('https://example.com', HTML);
    expect(r.finalUrl).toBe('https://www.example.com/final');
    expect(r.bytes.toString('utf8')).toBe('final');
  });

  it('caps the redirect chain', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 302, headers: { location: 'https://example.com/loop' } })
    );
    expect(await code(safeFetch('https://example.com', HTML))).toBe('too_many_redirects');
  });
});
