import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Coverage for POST /api/internal/ping — the page-view beacon (client:
 * src/components/TrackView/TrackPageView.tsx). It sends no Content-Type, so
 * Next leaves `req.body` a RAW STRING and the handler does JSON.parse(req.body).
 *
 * Regression guard for the raw-500 landmine (was the joint-largest raw-500
 * source at ~7.7/h): bot/scraper traffic hits the beacon with a malformed
 * `referer` header or a malformed/empty body. Previously `new URL(referer)` and
 * `JSON.parse(req.body)` threw un-caught → raw 500. Both are invalid client
 * input → must be 400 (matching the existing host-mismatch 400), and the
 * happy path must still dispatch the ClickHouse pageView insert unchanged.
 */

const { mockPageView, devStore } = vi.hoisted(() => ({
  mockPageView: vi.fn(),
  devStore: { isDev: false },
}));

// PublicEndpoint wraps the handler with CORS/metrics we don't exercise here —
// pass it through so the route's own logic (referer parse, host guard, body
// parse, pageView dispatch) is what's under test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => handler,
}));

vi.mock('~/env/other', () => ({
  get isDev() {
    return devStore.isDev;
  },
  get isProd() {
    return !devStore.isDev;
  },
}));

// Tracker is the shared ClickHouse client; we assert .pageView() is called with
// the parsed payload on the happy path (identical insert to before).
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    pageView = mockPageView;
  },
}));

// getMatchingPathname maps the request path to a page id; a match dispatches the
// insert, no-match short-circuits to 200. Return the path itself as the id so a
// known path matches and an unknown one (returning undefined) does not.
vi.mock('~/shared/constants/pathname.constants', () => ({
  getMatchingPathname: (path: string) => (path === '/models/1' ? '/models/[id]' : undefined),
}));

function makeRes() {
  const res = {} as NextApiResponse & { _status?: number; _body?: unknown };
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as any;
  res.send = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  res.end = vi.fn(() => res) as any;
  return res;
}

function makeReq(opts: { host?: string; referer?: string; body?: string }) {
  return {
    method: 'POST',
    headers: {
      host: opts.host ?? 'civitai.com',
      ...(opts.referer !== undefined ? { referer: opts.referer } : {}),
    },
    // The real client always sends a JSON string (no Content-Type), so req.body
    // is a raw string here — mirroring production.
    body: opts.body,
  } as unknown as NextApiRequest;
}

const validBody = JSON.stringify({
  ads: true,
  duration: 5000,
  path: '/models/1',
  windowWidth: 1920,
  windowHeight: 1080,
});

describe('POST /api/internal/ping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devStore.isDev = false;
  });

  it('dispatches Tracker.pageView on a well-formed same-origin request (200)', async () => {
    const handler = (await import('~/pages/api/internal/ping')).default;
    const req = makeReq({ host: 'civitai.com', referer: 'https://civitai.com/models/1', body: validBody });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).toHaveBeenCalledTimes(1);
    expect(mockPageView).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: '/models/[id]', path: '/models/1', host: 'civitai.com', ads: true, duration: 5000 })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 400 (not 500) on a malformed referer header, no insert', async () => {
    const handler = (await import('~/pages/api/internal/ping')).default;
    // `new URL('://')` throws TypeError — the raw-500 landmine. Host is present
    // and valid so we isolate the referer-parse throw.
    const req = makeReq({ host: 'civitai.com', referer: '://not a url', body: validBody });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('invalid request');
  });

  it('returns 400 (not 500) on a malformed body, no insert', async () => {
    const handler = (await import('~/pages/api/internal/ping')).default;
    // Passes the referer/host guard, then JSON.parse('{not json') throws.
    const req = makeReq({ host: 'civitai.com', referer: 'https://civitai.com/models/1', body: '{not json' });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('invalid request');
  });

  it('returns 400 (not 500) on an empty body, no insert', async () => {
    const handler = (await import('~/pages/api/internal/ping')).default;
    // Empty/undefined body — JSON.parse(undefined) → SyntaxError.
    const req = makeReq({ host: 'civitai.com', referer: 'https://civitai.com/models/1' });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a cross-origin request (host mismatch) with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/internal/ping')).default;
    const req = makeReq({ host: 'civitai.com', referer: 'https://evil.example/models/1', body: validBody });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 without inserting when the path does not match a known pathname', async () => {
    const handler = (await import('~/pages/api/internal/ping')).default;
    const body = JSON.stringify({ duration: 5000, path: '/unknown/path' });
    const req = makeReq({ host: 'civitai.com', referer: 'https://civitai.com/unknown/path', body });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does NOT swallow a genuine tracker.pageView failure as a 400', async () => {
    // The parse guards must catch ONLY the referer/body throws — a real failure
    // in the insert path must still surface (reject), not become a 400.
    mockPageView.mockRejectedValueOnce(new Error('clickhouse down'));
    const handler = (await import('~/pages/api/internal/ping')).default;
    const req = makeReq({ host: 'civitai.com', referer: 'https://civitai.com/models/1', body: validBody });
    const res = makeRes();

    await expect(handler(req as any, res)).rejects.toThrow('clickhouse down');
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('short-circuits to 200 in dev without inserting', async () => {
    devStore.isDev = true;
    const handler = (await import('~/pages/api/internal/ping')).default;
    const req = makeReq({ host: 'civitai.com', referer: 'https://civitai.com/models/1', body: validBody });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
