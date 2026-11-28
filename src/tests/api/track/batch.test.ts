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
 *  - per-event parsing (400 on an empty / oversized batch or one with no valid event; a malformed
 *    event among good ones is dropped and the rest are dispatched),
 *  - each event is dispatched via the SAME Tracker.search()/Tracker.action() the
 *    tRPC resolvers used, with the EXACT per-event payload and in array order (so
 *    the ClickHouse inserts are byte-identical and only the transport changed),
 *  - dev short-circuits to 200 with no insert.
 */

const {
  mockSearch,
  mockAction,
  mockImpressions,
  mockGetSession,
  mockInsert,
  mockIsFlipt,
  mockBeginShadow,
  devStore,
} = vi.hoisted(() => ({
  // The beacon-go shadow sampler's entry point; undefined (not sampled) unless a test says otherwise.
  mockBeginShadow: vi.fn((..._args: unknown[]): unknown => undefined),
  mockIsFlipt: vi.fn(async (_flag: string, _entityId?: string) => false),
  mockSearch: vi.fn(),
  mockAction: vi.fn(),
  mockImpressions: vi.fn(),
  mockGetSession: vi.fn(),
  mockInsert: vi.fn(async () => undefined),
  devStore: { isDev: false, sessionResolved: true, sessionCookie: false },
}));

// PublicEndpoint wraps the handler with CORS/metrics we don't exercise here —
// pass it through so the route's own logic (origin guard, parse, dispatch) is what's
// under test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => handler,
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSessionToken: () =>
    devStore.sessionCookie ? { value: 'token', name: 'civ-token', slot: 'shared' } : null,
}));

vi.mock('~/env/other', () => ({
  get isDev() {
    return devStore.isDev;
  },
  get isProd() {
    return !devStore.isDev;
  },
}));

vi.mock('~/server/beacon/beacon-go-shadow', () => ({ beginBeaconGoShadow: mockBeginShadow }));

// Tracker is the shared ClickHouse client; assert .search()/.action() are called
// with the exact per-event payload (same methods the tRPC resolvers used).
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    search = mockSearch;
    action = mockAction;
    impressions = mockImpressions;
    getSession = mockGetSession;
    get isSessionResolved() {
      return devStore.sessionResolved;
    }
  },
  clickhouse: { insert: mockInsert },
  trackerSends: () => true,
}));

// The beacon writes feed events straight to ClickHouse at the Flipt-set rate; record everything.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureFliptInitialized: async () => undefined,
  getFliptVariantDetailSync: () => ({ match: true, variantKey: '1', segmentKeys: [] }),
  isFlipt: mockIsFlipt,
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

const impressionEvent = {
  kind: 'impression' as const,
  data: {
    sessionKey: 'abc123',
    surface: 'images' as const,
    entities: [
      { entityType: 'Image' as const, entityId: 11 },
      { entityType: 'Model' as const, entityId: 22 },
    ],
  },
};

async function importHandler() {
  return (await import('~/pages/api/track/batch')).default;
}

describe('POST /api/track/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFlipt.mockReset().mockResolvedValue(false);
    devStore.isDev = false;
    devStore.sessionResolved = true;
    devStore.sessionCookie = false;
  });

  it('dispatches every event via the matching Tracker method, in order, with the exact payload', async () => {
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [searchEvent, actionEvent, searchEvent],
    });
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

  it('dispatches an impression event as ONE Tracker.impressions call carrying every entity', async () => {
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://civitai.com', body: [impressionEvent] });
    const res = makeRes();

    await handler(req as any, res);

    // One call, not one per entity. A route that looped the array and called per
    // entity would still produce the right rows, and would still pass a
    // row-shape assertion — it would just quietly restore the per-event insert
    // rate the batching exists to remove.
    expect(mockImpressions).toHaveBeenCalledTimes(1);
    expect(mockImpressions).toHaveBeenCalledWith(impressionEvent.data);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects an impression batch whose entity list exceeds the cap', async () => {
    const handler = await importHandler();
    const entities = Array.from({ length: 251 }, (_, i) => ({
      entityType: 'Image' as const,
      entityId: i + 1,
    }));
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [{ ...impressionEvent, data: { ...impressionEvent.data, entities } }],
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockImpressions).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('falls back to the "other" surface instead of rejecting an unknown one', async () => {
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [{ ...impressionEvent, data: { ...impressionEvent.data, surface: 'not-a-surface' } }],
    });
    const res = makeRes();

    await handler(req as any, res);

    // A batch is all-or-nothing at the schema layer, so a hard reject here would
    // discard every good event travelling with it.
    expect(mockImpressions).toHaveBeenCalledTimes(1);
    expect(mockImpressions.mock.calls[0][0].surface).toBe('other');
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

  it('drops a malformed event and still dispatches the good events around it', async () => {
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [searchEvent, { kind: 'from-a-newer-client', data: {} }, actionEvent],
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockSearch).toHaveBeenCalledWith(searchEvent.data);
    expect(mockAction).toHaveBeenCalledWith(actionEvent.data);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('records a feed event with the viewer from the session, never from the payload', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 5, tier: 'gold' } });
    const handler = await importHandler();
    const feedEvent = {
      kind: 'feed',
      data: {
        event: 'load',
        sessionKey: 's1',
        feed: 'models',
        page: '/models',
        sort: 'Hot',
        pageIndex: 0,
        filters: { hidePaid: 'true' },
        userId: 999,
        memberType: 'bronze',
      },
    };
    const req = makeReq({ origin: 'https://civitai.com', body: [feedEvent] });
    const res = makeRes();

    await handler(req as any, res);
    const { feedEventsRecorder } = await import('~/server/services/feed-events.service');
    await vi.waitFor(async () => {
      await feedEventsRecorder().flush();
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    const [{ table, values }] = mockInsert.mock.calls[0] as unknown as [
      { table: string; values: Record<string, unknown>[] }
    ];
    expect(table).toBe('feedEvents');
    // Rows must land, untagged, on a table the cohort DDL has not reached yet.
    expect((mockInsert.mock.calls[0] as unknown as [object])[0]).toMatchObject({
      clickhouse_settings: { input_format_skip_unknown_fields: 1 },
    });
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      userId: 5,
      memberType: 'gold',
      event: 'load',
      feed: 'models',
      filters: { hidePaid: 'true' },
    });
  });

  it('drops a feed event when the session lookup failed, rather than recording it signed out', async () => {
    mockGetSession.mockResolvedValue(null);
    devStore.sessionResolved = false;
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [
        {
          kind: 'feed',
          data: { event: 'load', sessionKey: 's1', feed: 'models', page: '/models' },
        },
      ],
    });

    await handler(req as any, makeRes());
    await vi.waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    const { feedEventsRecorder } = await import('~/server/services/feed-events.service');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await feedEventsRecorder().flush();

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('drops a feed event that carries a session cookie but resolved no session (hub unreachable)', async () => {
    mockGetSession.mockResolvedValue(null);
    devStore.sessionCookie = true;
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [
        {
          kind: 'feed',
          data: { event: 'load', sessionKey: 's1', feed: 'models', page: '/models' },
        },
      ],
    });

    await handler(req as any, makeRes());
    await vi.waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    const { feedEventsRecorder } = await import('~/server/services/feed-events.service');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await feedEventsRecorder().flush();

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("tags a signed-in viewer's feed rows with the personal-hot-lead flag, evaluated once a batch", async () => {
    mockGetSession.mockResolvedValue({ user: { id: 5, tier: 'gold' } });
    mockIsFlipt.mockResolvedValue(true);
    const load = { event: 'load', sessionKey: 's1', feed: 'models', page: '/models' };
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [
        { kind: 'feed', data: load },
        { kind: 'feed', data: { ...load, event: 'seen', seenIds: [3] } },
      ],
    });

    await handler(req as any, makeRes());
    const { feedEventsRecorder } = await import('~/server/services/feed-events.service');
    await vi.waitFor(async () => {
      await feedEventsRecorder().flush();
      expect(mockInsert).toHaveBeenCalled();
    });
    const values = mockInsert.mock.calls.flatMap(
      (call) => (call as unknown as [{ values: { personalHotLead: unknown }[] }])[0].values
    );
    expect(values.map((row) => row.personalHotLead)).toEqual([true, true]);
    expect(mockIsFlipt.mock.calls).toEqual([['personal-hot-lead', '5', expect.any(Object)]]);
  });

  it('records a signed-out viewer (no session cookie) as userId 0', async () => {
    mockGetSession.mockResolvedValue(null);
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [
        {
          kind: 'feed',
          data: { event: 'load', sessionKey: 's1', feed: 'models', page: '/models' },
        },
      ],
    });

    await handler(req as any, makeRes());
    const { feedEventsRecorder } = await import('~/server/services/feed-events.service');
    await vi.waitFor(async () => {
      await feedEventsRecorder().flush();
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
    const [{ values }] = mockInsert.mock.calls[0] as unknown as [
      { values: { userId: number; personalHotLead: unknown }[] }
    ];
    expect(values[0].userId).toBe(0);
    expect(values[0].personalHotLead).toBeNull();
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });

  // The beacon-go shadow sampler (~/server/beacon/beacon-go-shadow, off by default: its own sample
  // rate and the beacon-go-shadow flag; its gates are pinned in beacon-go-shadow.test.ts). A sampled
  // request attaches it to the Tracker before any event is dispatched (the rows arrive through
  // Tracker.onSend) and holds the mirror for every search and action row, the two kinds beacon-go
  // writes; impression and feed events are not waited for.
  it('wires a sampled request to the beacon-go shadow: attach first, then wait for each search and action', async () => {
    const order: string[] = [];
    const handle = {
      attach: vi.fn(() => order.push('attach')),
      waitFor: vi.fn((p: unknown) => order.push(`wait:${String((p as { tag?: string }).tag)}`)),
    };
    mockBeginShadow.mockReturnValueOnce(handle);
    const searched = Object.assign(Promise.resolve(true), { tag: 'search' });
    const acted = Object.assign(Promise.resolve(true), { tag: 'action' });
    mockSearch.mockImplementationOnce(() => {
      order.push('search');
      return searched;
    });
    mockAction.mockImplementationOnce(() => {
      order.push('action');
      return acted;
    });
    const handler = await importHandler();
    const req = makeReq({
      origin: 'https://civitai.com',
      body: [searchEvent, impressionEvent, actionEvent],
    });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBeginShadow).toHaveBeenCalledTimes(1);
    const [shadowReq, shadowRes, endpoint, sends] = mockBeginShadow.mock.calls[0];
    expect(shadowReq).toBe(req);
    expect(shadowRes).toBe(res);
    expect(endpoint).toBe('track-batch');
    expect((sends as () => boolean)()).toBe(true);
    expect(handle.attach).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['attach', 'search', 'wait:search', 'action', 'wait:action']);
    expect(handle.waitFor).toHaveBeenNthCalledWith(1, searched);
    expect(handle.waitFor).toHaveBeenNthCalledWith(2, acted);
    expect(mockImpressions).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('asks the shadow sampler before the origin guard, and dispatches nothing on a 400', async () => {
    const handle = { attach: vi.fn(), waitFor: vi.fn() };
    mockBeginShadow.mockReturnValueOnce(handle);
    const handler = await importHandler();
    const req = makeReq({ origin: 'https://evil.example', body: [searchEvent] });
    const res = makeRes();

    await handler(req as any, res);

    expect(mockBeginShadow).toHaveBeenCalledTimes(1);
    expect(handle.attach).not.toHaveBeenCalled();
    expect(handle.waitFor).not.toHaveBeenCalled();
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
