import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Coverage for POST /api/track/batch — the coalesced telemetry beacon that
 * replaces one-tRPC-call-per-event for track.trackSearch + track.addAction
 * (Load-reduction B1).
 *
 * Verifies the behavior-preserving contract:
 *  - same-origin guard (origin/referer host must equal request host),
 *  - tolerant body parse (object from Next's json parser OR raw string),
 *  - trackBatchSchema validation (400 on empty / oversized / malformed batch),
 *  - each event is dispatched via the SAME Tracker.search()/Tracker.action() the
 *    tRPC resolvers used, with the EXACT per-event payload and in array order (so
 *    the ClickHouse inserts are byte-identical and only the transport changed),
 *  - dev short-circuits to 200 with no insert.
 */

const { mockSearch, mockAction, devStore } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockAction: vi.fn(),
  devStore: { isDev: false },
}));

// PublicEndpoint wraps the handler with CORS/metrics we don't exercise here —
// pass it through so the route's own logic (origin guard, parse, dispatch) is what's
// under test.
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

// Tracker is the shared ClickHouse client; assert .search()/.action() are called
// with the exact per-event payload (same methods the tRPC resolvers used).
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    search = mockSearch;
    action = mockAction;
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
  // Pass `body` through as an OBJECT to simulate Next's application/json parser
  // (the real browser path). Default stringifies (text/plain client).
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

const searchEvent = { kind: 'search' as const, data: { query: 'cats', index: 'models' } };
const actionEvent = {
  kind: 'action' as const,
  data: { type: 'Tip_Click' as const, details: { toUserId: 7 } },
};

async function importHandler() {
  return (await import('~/pages/api/track/batch')).default;
}

describe('POST /api/track/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devStore.isDev = false;
  });

  it('dispatches every event via the matching Tracker method, in order, with the exact payload', async () => {
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://civitai.com', body: [searchEvent, actionEvent, searchEvent] });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenNthCalledWith(1, searchEvent.data);
    expect(mockAction).toHaveBeenNthCalledWith(1, actionEvent.data);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('dispatches when Next pre-parsed the body to an OBJECT (application/json — real browser path)', async () => {
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://civitai.com', body: [searchEvent], objectBody: true });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(searchEvent.data);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('accepts the referer host as the origin fallback', async () => {
    const handler = await importHandler();
    const req = makeReq({ referer: 'https://civitai.com/models/1', body: [actionEvent] });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects a cross-origin request (host mismatch) with 400 and no dispatch', async () => {
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://evil.example', body: [searchEvent] });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockAction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a request with no origin/referer with 400 and no dispatch', async () => {
    const handler = await importHandler();
    const req = makeReq({ body: [searchEvent] });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an unparseable body with 400 and no dispatch', async () => {
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://civitai.com', body: '{not json' });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an empty batch (min 1) with 400 and no dispatch', async () => {
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://civitai.com', body: [] });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockAction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an oversized batch (> TRACK_BATCH_MAX) with 400 and no dispatch', async () => {
    const { TRACK_BATCH_MAX } = await import('~/server/schema/track.schema');
    const handler = await importHandler();
    const tooMany = Array.from({ length: TRACK_BATCH_MAX + 1 }, () => searchEvent);
    const req = makeReq({ origin: 'https://civitai.com', body: tooMany });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a malformed event (unknown kind) with 400 and no dispatch', async () => {
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://civitai.com', body: [{ kind: 'bogus', data: {} }] });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockAction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a malformed action event (bad discriminated type) with 400 and no dispatch', async () => {
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [{ kind: 'action', data: { type: 'NotARealAction' } }],
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockAction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('short-circuits to 200 in dev without dispatching', async () => {
    devStore.isDev = true;
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://civitai.com', body: [searchEvent] });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
