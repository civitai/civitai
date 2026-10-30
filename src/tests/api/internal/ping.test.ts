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
//
// The leading `.replace` mirrors the real implementation's FIRST operation
// (`url.replace(/^\//, '')`), which is what makes a missing or non-string `path`
// throw a TypeError in production. Keeping it here is what lets the body-schema
// tests below prove that case is a 400 and not an escaping raw 500 — a mock that
// silently tolerated a non-string would have made those tests vacuous.
vi.mock('~/shared/constants/pathname.constants', () => ({
  getMatchingPathname: (path: string) => {
    path.replace(/^\//, '');
    return path === '/models/1' ? '/models/[id]' : undefined;
  },
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
    const req = makeReq({
      host: 'civitai.com',
      referer: 'https://civitai.com/models/1',
      body: validBody,
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).toHaveBeenCalledTimes(1);
    expect(mockPageView).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: '/models/[id]',
        path: '/models/1',
        host: 'civitai.com',
        ads: true,
        duration: 5000,
      })
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
    const req = makeReq({
      host: 'civitai.com',
      referer: 'https://civitai.com/models/1',
      body: '{not json',
    });
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
    const req = makeReq({
      host: 'civitai.com',
      referer: 'https://evil.example/models/1',
      body: validBody,
    });
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
    const req = makeReq({
      host: 'civitai.com',
      referer: 'https://civitai.com/models/1',
      body: validBody,
    });
    const res = makeRes();

    await expect(handler(req as any, res)).rejects.toThrow('clickhouse down');
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('short-circuits to 200 in dev without inserting', async () => {
    devStore.isDev = true;
    const handler = (await import('~/pages/api/internal/ping')).default;
    const req = makeReq({
      host: 'civitai.com',
      referer: 'https://civitai.com/models/1',
      body: validBody,
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockPageView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

/**
 * Body-shape validation (pageViewBeaconSchema).
 *
 * Before the schema the handler TYPE-asserted `JSON.parse`'s `any` and forwarded
 * the fields verbatim, which produced three silent defects:
 *
 *  1. `ads` reached a BOOLEAN analytics column carrying whatever the caller sent.
 *     The analytics client rejects a non-boolean there and drops the row without
 *     the app seeing an error (the beacon is fire-and-forget), so a bad `ads`
 *     destroyed the page view invisibly.
 *  2. A missing or non-string `path` threw inside `getMatchingPathname` and
 *     escaped as a raw 500 on a public endpoint.
 *  3. A numeric STRING dimension became 0, because the downstream column clamp
 *     opens with `Number.isFinite(value)` and that is `false` for a string.
 *
 * The schema COERCES-AND-DEFAULTS rather than rejecting, because a body omitting
 * `duration`/the window dimensions already wrote a row and 400ing it would cut
 * page-view volume. `path` is the sole required field.
 */
describe('POST /api/internal/ping — body shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devStore.isDev = false;
  });

  async function post(body: unknown) {
    const handler = (await import('~/pages/api/internal/ping')).default;
    const req = makeReq({
      host: 'civitai.com',
      referer: 'https://civitai.com/models/1',
      body: JSON.stringify(body),
    });
    const res = makeRes();
    await handler(req as any, res);
    return res;
  }

  /** The single payload the tracker was handed, or undefined if it was never called. */
  function payload() {
    return mockPageView.mock.calls[0]?.[0];
  }

  describe('ads must reach the boolean column as a real boolean', () => {
    // Defect 1. The tell is the TYPE, not just the value — asserting `false`
    // alone would pass for the string 'false', which is exactly what kills the row.
    // `null` is an INVARIANT guard, not a regression test — the previous
    // `ads ?? false` already handled it. The other four were the live defect.
    it.each([
      ['a string', 'true'],
      ['a number', 1],
      ['an object', {}],
      ['an array', []],
      ['null (invariant guard — already handled by the previous `?? false`)', null],
    ])('coerces %s to boolean false and still writes the row', async (_label, ads) => {
      const res = await post({
        ads,
        duration: 5000,
        path: '/models/1',
        windowWidth: 1920,
        windowHeight: 1080,
      });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockPageView).toHaveBeenCalledTimes(1);
      expect(typeof payload().ads).toBe('boolean');
      expect(payload().ads).toBe(false);
    });

    it('defaults an absent ads to boolean false', async () => {
      // The real client sends `ads: undefined` and removeEmpty strips it, so
      // this is the COMMON production shape, not an edge case. INVARIANT guard:
      // the previous `ads ?? false` already produced `false` here.
      const res = await post({
        duration: 5000,
        path: '/models/1',
        windowWidth: 1920,
        windowHeight: 1080,
      });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(typeof payload().ads).toBe('boolean');
      expect(payload().ads).toBe(false);
    });

    it('passes a genuine ads:true through unchanged', async () => {
      // Invariant guard, not a regression test: this passed before the schema too.
      const res = await post({
        ads: true,
        duration: 5000,
        path: '/models/1',
        windowWidth: 1920,
        windowHeight: 1080,
      });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(payload().ads).toBe(true);
    });
  });

  describe('path is required and must be a string', () => {
    // Defect 2. Each of these previously reached `getMatchingPathname`, whose
    // first operation is `url.replace(...)` — a TypeError escaping as a raw 500.
    it.each([
      ['a number', 123],
      ['null', null],
      ['an object', {}],
      ['an array', []],
      ['a boolean', true],
    ])('rejects %s path with 400 and no insert', async (_label, path) => {
      const res = await post({
        ads: true,
        duration: 5000,
        path,
        windowWidth: 1920,
        windowHeight: 1080,
      });

      expect(mockPageView).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith('invalid request');
    });

    it('rejects an absent path with 400 and no insert', async () => {
      const res = await post({ ads: true, duration: 5000, windowWidth: 1920, windowHeight: 1080 });

      expect(mockPageView).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith('invalid request');
    });

    it.each([
      ['a JSON null body', null],
      ['a JSON string body', 'hello'],
      ['a JSON number body', 7],
    ])('rejects %s with 400 and no insert', async (_label, body) => {
      // These parse fine as JSON but are not objects. `null` in particular threw
      // on destructuring — another raw 500 on the same path.
      const res = await post(body);

      expect(mockPageView).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('numeric fields accept a numeric string without losing the value', () => {
    // Defect 3. `Number.isFinite('1920')` is false — no coercion — so the
    // downstream clamp wrote 0 for a dimension the client did send.
    it('preserves numeric-string window dimensions', async () => {
      const res = await post({
        ads: true,
        duration: 5000,
        path: '/models/1',
        windowWidth: '1920',
        windowHeight: '1080',
      });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(payload().windowWidth).toBe(1920);
      expect(payload().windowHeight).toBe(1080);
      expect(typeof payload().windowWidth).toBe('number');
      expect(typeof payload().windowHeight).toBe('number');
    });

    it('preserves a numeric-string duration', async () => {
      // INVARIANT guard, and the asymmetry is the point: `duration` went through
      // `Math.floor`, which DOES coerce a numeric string, so this one field was
      // already correct. The window dimensions went through `?? 0` and then a
      // `Number.isFinite` clamp, which does NOT coerce — hence defect 3 hitting
      // only them. The schema now makes all three behave the same way.
      const res = await post({ ads: true, duration: '5000', path: '/models/1' });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(payload().duration).toBe(5000);
    });

    // `null` is an INVARIANT guard (`null ?? 0` and `Math.floor(null)` were both
    // already 0); the other four were previously forwarded verbatim or as NaN.
    it.each([
      ['a non-numeric string', 'abc'],
      ['a boolean', true],
      ['an object', {}],
      ['null (invariant guard — already 0)', null],
      ['an empty string', ''],
    ])('falls back to 0 for %s rather than rejecting the row', async (_label, value) => {
      const res = await post({
        ads: true,
        duration: value,
        path: '/models/1',
        windowWidth: value,
        windowHeight: value,
      });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockPageView).toHaveBeenCalledTimes(1);
      expect(payload().duration).toBe(0);
      expect(payload().windowWidth).toBe(0);
      expect(payload().windowHeight).toBe(0);
    });
  });

  describe('coerce-and-default preserves the rows that already wrote', () => {
    // No-regression guard for the design decision. A `.strict()` schema that
    // 400d on a missing field would silently reduce page-view volume, which is
    // the opposite of the point.
    it('still writes a row for a body carrying only path', async () => {
      // INVARIANT guard for the design decision — a body this sparse DID write a
      // row before the schema, and this test pins that it still does. It is the
      // guard that would go red if anyone later tightened the schema into a
      // `.strict()` reject-everything parse, which would silently cut volume.
      const res = await post({ path: '/models/1' });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockPageView).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(400);
    });

    it('sends finite numbers, not NaN, for a body carrying only path', async () => {
      // Regression half of the test above: previously `Math.floor(undefined)`
      // handed the insert a NaN duration. The row survived only because the
      // downstream clamp mapped NaN to 0 — this pins the value at the boundary
      // the handler owns, so the fix does not depend on that clamp.
      await post({ path: '/models/1' });

      expect(payload()).toEqual(
        expect.objectContaining({
          pageId: '/models/[id]',
          path: '/models/1',
          ads: false,
          duration: 0,
          windowWidth: 0,
          windowHeight: 0,
        })
      );
      expect(Number.isNaN(payload().duration)).toBe(false);
    });

    it('strips an unknown key rather than forwarding it into the insert', async () => {
      // INVARIANT guard: the previous code destructured named fields explicitly,
      // so an unknown key never reached the insert either. Pinned because the
      // schema is now the thing responsible for it.
      const res = await post({ path: '/models/1', duration: 5000, injected: 'nope' });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(payload()).not.toHaveProperty('injected');
    });
  });
});
