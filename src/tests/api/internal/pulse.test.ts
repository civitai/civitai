import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Coverage for POST /api/internal/pulse — the lightweight beacon that replaces the
 * track.addView tRPC mutation for the browser <TrackView> component.
 *
 * Verifies the behavior-preserving contract:
 *  - same-origin guard (origin/referer host must equal request host),
 *  - body parse + addViewSchema validation (400 on bad input),
 *  - the ClickHouse `views` insert is dispatched via Tracker.view() with the
 *    FULL parsed payload (so the analytics shape/volume is unchanged),
 *  - dev short-circuits to 200 with no insert.
 */

const { mockView, devStore } = vi.hoisted(() => ({
  mockView: vi.fn(),
  devStore: { isDev: false },
}));

// PublicEndpoint wraps the handler with CORS/metrics we don't exercise here —
// pass it through so the route's own logic (origin guard, parse, view dispatch)
// is what's under test. allowedMethods is irrelevant to a passthrough.
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

// Tracker is the shared ClickHouse client; we assert .view() is called with the
// exact parsed payload (same method the tRPC resolver used → identical insert).
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    view = mockView;
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

function makeReq(opts: {
  host?: string;
  origin?: string;
  referer?: string;
  body?: unknown;
  // When true, pass `body` through as-is (an OBJECT) to simulate how Next's body
  // parser delivers an `application/json` request — which is the real browser path
  // (<TrackView> sends Content-Type: application/json). Default stringifies, which
  // only matches a no-Content-Type (text/plain) client.
  objectBody?: boolean;
}) {
  return {
    method: 'POST',
    headers: {
      host: opts.host ?? 'civitai.com',
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.referer ? { referer: opts.referer } : {}),
    },
    body: opts.objectBody
      ? opts.body
      : typeof opts.body === 'string'
      ? opts.body
      : JSON.stringify(opts.body),
  } as unknown as NextApiRequest;
}

const validInput = {
  type: 'ImageView' as const,
  entityType: 'Image' as const,
  entityId: 123,
  ads: 'Served' as const,
  nsfw: false,
  browsingLevel: 1,
  nsfwLevel: 0,
  details: { foo: 'bar' },
};

describe('POST /api/internal/pulse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devStore.isDev = false;
  });

  it('dispatches Tracker.view with the full parsed payload on a same-origin request', async () => {
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = makeReq({ host: 'civitai.com', origin: 'https://civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).toHaveBeenCalledTimes(1);
    expect(mockView).toHaveBeenCalledWith(validInput);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('dispatches when Next pre-parsed the body to an OBJECT (application/json — the real browser path)', async () => {
    // Regression guard: the <TrackView> client sends Content-Type: application/json,
    // so Next's body parser hands the handler an OBJECT, not a string. A naive
    // JSON.parse(req.body) would throw on the object → 400 → drop EVERY production
    // view. This must dispatch the insert exactly like the string path.
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: validInput, objectBody: true });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).toHaveBeenCalledTimes(1);
    expect(mockView).toHaveBeenCalledWith(validInput);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('preserves false/0-valued fields (nsfw:false, nsfwLevel:0) in the insert', async () => {
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const body = { type: 'ModelView', entityType: 'Model', entityId: 7, nsfw: false, nsfwLevel: 0 };
    const req = makeReq({ origin: 'https://civitai.com', body });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 7, nsfw: false, nsfwLevel: 0 })
    );
  });

  it('accepts the referer host as the origin fallback', async () => {
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = makeReq({ host: 'civitai.com', referer: 'https://civitai.com/models/1', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects a cross-origin request (host mismatch) with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = makeReq({ host: 'civitai.com', origin: 'https://evil.example', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a request with no origin/referer with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = makeReq({ host: 'civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an unparseable body with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: '{not json' });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects schema-invalid input (bad enum) with 400 and no insert', async () => {
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = makeReq({
      origin: 'https://civitai.com',
      body: { type: 'NotAView', entityType: 'Image', entityId: 1 },
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('short-circuits to 200 in dev without inserting', async () => {
    devStore.isDev = true;
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = makeReq({ origin: 'https://civitai.com', body: validInput });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockView).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
