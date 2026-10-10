import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import client from 'prom-client';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as CivitaiRedis from '@civitai/redis';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { calledHybridNodes } from '~/__tests__/mocks/hybrid';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as RateLimitModule from '~/server/services/blocks/block-event-rate-limit';

/**
 * POST /api/track/block-event, driven through the real ingest: the real approved-app cache (over
 * the database mock), the real manifest parser, the real viewer-key and rate-limit modules and the
 * real prom counter. Only the edges are stubbed: the session, the ClickHouse client, the
 * private-run predicate and the deployment signals. Redis is the canonical mock, and every case
 * fails if the ingest touches it (see `redisTouched`).
 *
 * `PublicEndpoint` is replaced by a pass-through that records the allowed methods, so the method
 * gate itself (which that wrapper owns) is not exercised here; what is pinned is that the route
 * asks for POST only.
 *
 * Nothing in this file touches a network: every sink is a mock.
 */

const { devStore, envStore, sessionStore, chStore, mockInsert, mockGetSession, mockPrivateRun } =
  vi.hoisted(() => ({
    devStore: { isDev: false },
    envStore: { isPreview: false, cacheKeyNamespace: '' },
    sessionStore: { session: null as { user?: { id: number } } | null },
    chStore: { present: true },
    mockInsert: vi.fn(),
    mockGetSession: vi.fn(),
    mockPrivateRun: vi.fn(),
  }));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: object, allowedMethods: string[]) =>
    Object.assign(handler, { allowedMethods }),
}));

vi.mock('~/env/other', () => ({
  get isDev() {
    return devStore.isDev;
  },
  get isPreview() {
    return envStore.isPreview;
  },
  isProd: false,
  isTest: true,
}));

vi.mock('@civitai/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiRedis>()),
  get CACHE_KEY_NAMESPACE() {
    return envStore.cacheKeyNamespace;
  },
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: (...args: unknown[]) => {
    mockGetSession(...args);
    return Promise.resolve(sessionStore.session);
  },
}));

vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return chStore.present ? { insert: mockInsert } : undefined;
  },
}));

vi.mock('~/server/services/blocks/private-run-impression.service', () => ({
  isPrivateRunImpression: mockPrivateRun,
}));

// ── fixtures ─────────────────────────────────────────────────────────────────

const APP = 'apb_arcade';
const OTHER_APP = 'apb_shop';
const APP_OWNER = 6611;
const OTHER_VIEWER = 9102;

const APPROVED_ROWS = [
  {
    id: APP,
    app: { userId: APP_OWNER },
    manifest: {
      analytics: {
        events: {
          level_cleared: {
            properties: {
              difficulty: { type: 'enum', values: ['calm', 'brutal'] },
              seconds: { type: 'number' },
              assisted: { type: 'boolean' },
              // A legal declared name that every object also inherits.
              constructor: { type: 'enum', values: ['wizard'] },
            },
          },
          menu_opened: {},
        },
      },
    },
  },
  {
    id: OTHER_APP,
    app: { userId: 6622 },
    manifest: {
      analytics: {
        events: {
          purchase_started: { properties: { tier: { type: 'enum', values: ['bronze'] } } },
        },
      },
    },
  },
];

const DAY_1_NOON = Date.UTC(2031, 2, 14, 12, 0, 0);
const VIEWER_IP = '198.51.100.23';

// ── Redis must never be touched ──────────────────────────────────────────────

/**
 * Every call made to ANY command of the canonical Redis mock (`redis`, `sysRedis` and the
 * `withSysReadDeadline` seam), at any depth, since the last mock reset. Read from the hybrid
 * mock's own node registry, so a command nobody listed here is seen as well.
 */
function redisTouched(): string[] {
  return calledHybridNodes(['redis', 'sysRedis', 'withSysReadDeadline']);
}

// ── harness ──────────────────────────────────────────────────────────────────

type Handler = ((req: NextApiRequest, res: NextApiResponse) => Promise<unknown>) & {
  allowedMethods: string[];
};

async function loadHandler(): Promise<Handler> {
  return (await import('~/pages/api/track/block-event')).default as unknown as Handler;
}

function makeRes() {
  const res = {} as NextApiResponse & { _status?: number; _body?: unknown };
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as unknown as NextApiResponse['status'];
  res.send = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as unknown as NextApiResponse['send'];
  res.end = vi.fn(() => res) as unknown as NextApiResponse['end'];
  return res;
}

type PostOptions = {
  ip?: string | null;
  origin?: string | null;
  rawBody?: string;
  objectBody?: boolean;
  handler?: Handler;
  /** Send the address header WITHOUT the edge's request id, as a direct-to-origin caller would. */
  noEdge?: boolean;
  /** The transport peer, as a reverse proxy in front of the app would present itself. */
  socketIp?: string;
};

async function post(body: unknown, opts: PostOptions = {}) {
  const handler = opts.handler ?? (await loadHandler());
  const ip = opts.ip === undefined ? VIEWER_IP : opts.ip;
  const origin = opts.origin === undefined ? 'https://civitai.com' : opts.origin;
  const req = {
    method: 'POST',
    headers: {
      host: 'civitai.com',
      ...(origin ? { origin } : {}),
      // Edge-attested: the address header counts only alongside the edge's own request id.
      ...(ip ? { 'cf-connecting-ip': ip, ...(opts.noEdge ? {} : { 'cf-ray': 'test-ray' }) } : {}),
    },
    ...(opts.socketIp ? { socket: { remoteAddress: opts.socketIp } } : {}),
    body: opts.rawBody ?? (opts.objectBody ? body : JSON.stringify(body)),
  } as unknown as NextApiRequest;
  const res = makeRes();
  await handler(req, res);
  // The insert and its counters settle off the request path.
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

/** A page instance id is the app's own page id, so the default follows the row's app. */
const event = (over: Record<string, unknown> = {}) => {
  const appBlockId = typeof over.appBlockId === 'string' ? over.appBlockId.trim() : APP;
  return {
    appBlockId: APP,
    blockInstanceId: `page_${appBlockId}`,
    eventName: 'menu_opened',
    ...over,
  };
};

type Row = {
  time: string;
  appBlockId: string;
  blockInstanceId: string;
  eventName: string;
  userId: number;
  viewerKey: unknown;
  isAnon: number;
  isOwner: number;
  enumProps: Record<string, string>;
  numProps: Record<string, number>;
  boolProps: Record<string, number>;
};

function insertedRows(): Row[] {
  return mockInsert.mock.calls.flatMap(([arg]) => (arg as { values: Row[] }).values);
}

async function outcomes(): Promise<Record<string, number>> {
  const metric = client.register.getSingleMetric('civitai_app_block_custom_events_total');
  if (!metric) return {};
  const data = await (
    metric as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
    }
  ).get();
  return Object.fromEntries(data.values.map((v) => [v.labels.outcome, v.value]));
}

/** Run `fn` and return how far each outcome moved. Outcomes that did not move are absent. */
async function outcomeDelta(fn: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = await outcomes();
  await fn();
  const after = await outcomes();
  const delta: Record<string, number> = {};
  for (const [outcome, value] of Object.entries(after)) {
    const moved = value - (before[outcome] ?? 0);
    if (moved !== 0) delta[outcome] = moved;
  }
  return delta;
}

beforeEach(() => {
  // Fresh module instances per test: the approved-app cache and the limiter are
  // all process state.
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DAY_1_NOON);
  devStore.isDev = false;
  envStore.isPreview = false;
  envStore.cacheKeyNamespace = '';
  sessionStore.session = null;
  chStore.present = true;
  // Fail closed means unset skips the write, so the positive signal is set for every case and a
  // case about the gate overrides it.
  vi.stubEnv('CIVITAI_DEPLOYMENT_ENVIRONMENT', 'production');
  mockGetSession.mockReset();
  mockInsert.mockReset();
  mockInsert.mockImplementation(async () => undefined);
  mockPrivateRun.mockImplementation(async () => false);
  loggingMock.logToAxiom.mockImplementation(async () => undefined);
  dbMock.dbRead.appBlock.findMany.mockResolvedValue(APPROVED_ROWS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  // No path of the ingest uses Redis; a call here would be a new storage dependency.
  expect(redisTouched()).toEqual([]);
});

describe('the Redis guard itself', () => {
  it('POSITIVE CONTROL: sees a call to any command, at any depth, and is clean after a reset', () => {
    redisMock.sysRedis.hGetAll('k');
    redisMock.redis.zAdd('k', []);
    redisMock.redis.packed.get('k');
    expect(redisTouched()).toEqual(['redis.packed.get', 'redis.zAdd', 'sysRedis.hGetAll']);
    vi.clearAllMocks();
    expect(redisTouched()).toEqual([]);
  });
});

// ── the request gates ────────────────────────────────────────────────────────

describe('POST /api/track/block-event — request gates', () => {
  it('asks the endpoint wrapper for POST only', async () => {
    expect((await loadHandler()).allowedMethods).toEqual(['POST']);
  });

  it('refuses a beacon with no Origin or Referer, and a cross-origin one', async () => {
    for (const origin of [null, 'https://evil.example', 'https://evil.civitai.com']) {
      const res = await post({ events: [event()] }, { origin });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res._body).toBe('invalid request');
    }
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('refuses a batch of 51 and an empty one, and accepts exactly 50', async () => {
    const batch = (n: number) => ({ events: Array.from({ length: n }, () => event()) });
    expect((await post(batch(51))).status).toHaveBeenCalledWith(400);
    expect((await post({ events: [] })).status).toHaveBeenCalledWith(400);
    expect(mockInsert).not.toHaveBeenCalled();

    expect((await post(batch(50))).status).toHaveBeenCalledWith(200);
    expect(insertedRows()).toHaveLength(50);
  });

  it('refuses a row with no app or instance id, and an unparseable body', async () => {
    for (const bad of [{ appBlockId: '' }, { blockInstanceId: undefined }, { appBlockId: 7 }]) {
      expect((await post({ events: [event(bad)] })).status).toHaveBeenCalledWith(400);
    }
    expect((await post(null, { rawBody: '{not json' })).status).toHaveBeenCalledWith(400);
    expect((await post({ nope: true })).status).toHaveBeenCalledWith(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('accepts an object body as well as a string one', async () => {
    expect((await post({ events: [event()] }, { objectBody: true })).status).toHaveBeenCalledWith(
      200
    );
    expect((await post({ events: [event()] })).status).toHaveBeenCalledWith(200);
    expect(insertedRows()).toHaveLength(2);
  });

  it('short-circuits in dev', async () => {
    devStore.isDev = true;
    const delta = await outcomeDelta(async () => {
      expect((await post({ events: [event()] })).status).toHaveBeenCalledWith(200);
    });
    expect(delta).toEqual({});
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ── the declared-only filter ─────────────────────────────────────────────────

describe('POST /api/track/block-event — what is stored', () => {
  it('writes one row for a declared event, into the events table', async () => {
    const delta = await outcomeDelta(() => post({ events: [event()] }));
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0]).toMatchObject({
      table: 'appBlockEvents',
      format: 'JSONEachRow',
    });
    expect(insertedRows()).toEqual([
      expect.objectContaining({
        appBlockId: 'apb_arcade',
        blockInstanceId: 'page_apb_arcade',
        eventName: 'menu_opened',
        enumProps: {},
        numProps: {},
        boolProps: {},
      }),
    ]);
    expect(delta).toEqual({ accepted: 1 });
  });

  it('drops an unknown app, counts it, and does no further work for it', async () => {
    const delta = await outcomeDelta(() =>
      post({
        events: [
          event({ appBlockId: 'apb_never_approved' }),
          event({ appBlockId: 'apb_never_approved' }),
          event({ appBlockId: 'x' }),
        ],
      })
    );
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(delta).toEqual({ unknown_app: 3 });
  });

  it('keeps the approved rows of a batch that also carries an unknown app', async () => {
    const delta = await outcomeDelta(() =>
      post({
        events: [
          event({ appBlockId: 'apb_never_approved' }),
          event(),
          event({ appBlockId: OTHER_APP, eventName: 'purchase_started' }),
        ],
      })
    );
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(insertedRows().map((r) => [r.appBlockId, r.eventName])).toEqual([
      ['apb_arcade', 'menu_opened'],
      ['apb_shop', 'purchase_started'],
    ]);
    expect(delta).toEqual({ unknown_app: 1, accepted: 2 });
  });

  it('🔴 stores an undeclared event as ONE `__undeclared__` row and never the name sent', async () => {
    const delta = await outcomeDelta(() =>
      post({
        events: [
          event({
            eventName: 'secret_prompt_text_leak',
            properties: { difficulty: 'brutal', free: 'my-private-note', seconds: 3 },
          }),
        ],
      })
    );
    expect(insertedRows()).toEqual([
      expect.objectContaining({
        eventName: '__undeclared__',
        enumProps: {},
        numProps: {},
        boolProps: {},
      }),
    ]);
    // Scan everything handed to the sink, not just the field the name would normally sit in.
    const payload = JSON.stringify(mockInsert.mock.calls);
    expect(payload).toContain('__undeclared__');
    expect(payload).not.toContain('secret_prompt_text_leak');
    expect(payload).not.toContain('my-private-note');
    expect(payload).not.toContain('brutal');
    expect(delta).toEqual({ undeclared_event: 1 });
  });

  it("does not take another app's declared event, or an inherited object key, as declared", async () => {
    await post({
      events: [
        event({ eventName: 'purchase_started' }),
        event({ eventName: 'constructor' }),
        event({ eventName: '__proto__' }),
        event({ eventName: 'toString' }),
        event({ eventName: 41 }),
        event({ eventName: { name: 'menu_opened' } }),
        event({ eventName: undefined }),
      ],
    });
    expect(insertedRows().map((r) => r.eventName)).toEqual(Array(7).fill('__undeclared__'));
  });

  it('keeps each valid declared property in the map for its type and strips the rest', async () => {
    const delta = await outcomeDelta(() =>
      post({
        events: [
          event({
            eventName: 'level_cleared',
            properties: {
              difficulty: 'calm',
              seconds: 12.25,
              assisted: false,
              // undeclared: stripped
              prompt: 'a castle at dusk',
              email: 'someone@example.com',
              nested: { difficulty: 'brutal' },
            },
          }),
        ],
      })
    );
    expect(insertedRows()).toEqual([
      expect.objectContaining({
        eventName: 'level_cleared',
        enumProps: { difficulty: 'calm' },
        numProps: { seconds: 12.25 },
        boolProps: { assisted: 0 },
      }),
    ]);
    const payload = JSON.stringify(mockInsert.mock.calls);
    expect(payload).not.toContain('castle');
    expect(payload).not.toContain('someone@example.com');
    expect(payload).not.toContain('nested');
    // Three undeclared properties on one row are one flag, not three.
    expect(delta).toEqual({ accepted: 1, undeclared_prop: 1 });
  });

  it('stores boolean true as 1', async () => {
    await post({ events: [event({ eventName: 'level_cleared', properties: { assisted: true } })] });
    expect(insertedRows()[0].boolProps).toEqual({ assisted: 1 });
  });

  it.each([
    ['an enum value the manifest does not declare', { difficulty: 'nightmare' }],
    ['an enum value in the wrong case', { difficulty: 'Calm' }],
    ['a number where an enum is declared', { difficulty: 3 }],
    ['a numeric string where a number is declared', { seconds: '12' }],
    ['NaN', { seconds: Number.NaN }],
    ['Infinity', { seconds: Number.POSITIVE_INFINITY }],
    ['null where a number is declared', { seconds: null }],
    ['a boolean where a number is declared', { seconds: true }],
    ['the string "true" where a boolean is declared', { assisted: 'true' }],
    ['1 where a boolean is declared', { assisted: 1 }],
    ['an object where an enum is declared', { difficulty: { toString: 'calm' } }],
  ])('strips %s and flags the row', async (_label, properties) => {
    // An object body, because NaN and Infinity do not survive JSON.stringify.
    const delta = await outcomeDelta(() =>
      post({ events: [event({ eventName: 'level_cleared', properties })] }, { objectBody: true })
    );
    expect(insertedRows()).toEqual([
      expect.objectContaining({
        eventName: 'level_cleared',
        enumProps: {},
        numProps: {},
        boolProps: {},
      }),
    ]);
    expect(delta).toEqual({ accepted: 1, invalid_value: 1 });
  });

  it('strips an out-of-range JSON number that parses to Infinity', async () => {
    const rawBody = `{"events":[{"appBlockId":"${APP}","blockInstanceId":"page_apb_arcade","eventName":"level_cleared","properties":{"seconds":1e999,"difficulty":"brutal"}}]}`;
    await post(null, { rawBody });
    expect(insertedRows()[0]).toMatchObject({ numProps: {}, enumProps: { difficulty: 'brutal' } });
  });

  it('flags a row once however many of its values are invalid, and keeps the valid one', async () => {
    const delta = await outcomeDelta(() =>
      post({
        events: [
          event({
            eventName: 'level_cleared',
            properties: { difficulty: 'nightmare', seconds: 'slow', assisted: true, extra: 1 },
          }),
        ],
      })
    );
    expect(insertedRows()[0]).toMatchObject({
      enumProps: {},
      numProps: {},
      boolProps: { assisted: 1 },
    });
    expect(delta).toEqual({ accepted: 1, invalid_value: 1, undeclared_prop: 1 });
  });

  it('does not read a declared property named `constructor` off the prototype', async () => {
    const absent = await outcomeDelta(() =>
      post({ events: [event({ eventName: 'level_cleared', properties: { seconds: 2 } })] })
    );
    expect(insertedRows()[0].enumProps).toEqual({});
    expect(absent).toEqual({ accepted: 1 });

    await post({
      events: [event({ eventName: 'level_cleared', properties: { constructor: 'wizard' } })],
    });
    expect(insertedRows()[1].enumProps).toEqual({ constructor: 'wizard' });
  });

  it('ignores `properties` that is not an object', async () => {
    const delta = await outcomeDelta(() =>
      post({
        events: [
          event({ eventName: 'level_cleared', properties: ['difficulty', 'calm'] }),
          event({ eventName: 'level_cleared', properties: 'difficulty=calm' }),
          event({ eventName: 'level_cleared', properties: null }),
        ],
      })
    );
    expect(insertedRows().map((r) => [r.enumProps, r.numProps, r.boolProps])).toEqual(
      Array(3).fill([{}, {}, {}])
    );
    expect(delta).toEqual({ accepted: 3 });
  });
});

// ── identity ─────────────────────────────────────────────────────────────────

describe('POST /api/track/block-event — identity is server-derived', () => {
  it('stamps a signed-in viewer from the session, with the key as a decimal STRING', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    await post({ events: [event()] });
    const [row] = insertedRows();
    expect(row).toMatchObject({ userId: 9102, isAnon: 0, isOwner: 0 });
    // sha256('u:9102'), first 8 bytes big-endian, computed outside this codebase.
    expect(row.viewerKey).toBe('988994381281639022');
    expect(typeof row.viewerKey).toBe('string');
  });

  it('sends the documented vector for user 42 as a string', async () => {
    sessionStore.session = { user: { id: 42 } };
    await post({ events: [event()] });
    expect(insertedRows()[0].viewerKey).toBe('6590179527920541835');
  });

  it('🔴 writes a signed-out row with the unknown-viewer key "0", as a string', async () => {
    const delta = await outcomeDelta(() => post({ events: [event()] }));
    const [row] = insertedRows();
    expect(row).toMatchObject({ userId: 0, isAnon: 1, isOwner: 0 });
    expect(row.viewerKey).toBe('0');
    expect(typeof row.viewerKey).toBe('string');
    expect(delta).toEqual({ accepted: 1 });
  });

  it('gives every signed-out viewer the same key, whatever their address', async () => {
    await post({ events: [event()] }, { ip: '198.51.100.23' });
    await post({ events: [event()] }, { ip: '203.0.113.9' });
    await post({ events: [event()] }, { ip: '2001:db8::1' });
    await post({ events: [event()] }, { ip: null });
    expect(insertedRows().map((r) => r.viewerKey)).toEqual(['0', '0', '0', '0']);
  });

  it('🔴 ignores identity, ownership and time sent in the body', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    await post({
      events: [
        event({
          userId: APP_OWNER,
          isOwner: 1,
          isAnon: 1,
          viewerKey: '1',
          ip: '192.0.2.99',
          ts: 946684800000,
          time: '2000-01-01 00:00:00.000',
        }),
      ],
    });
    const [row] = insertedRows();
    expect(row).toMatchObject({
      userId: 9102,
      isAnon: 0,
      isOwner: 0,
      viewerKey: '988994381281639022',
      time: '2031-03-14 12:00:00.000',
    });
    expect(Object.keys(row).sort()).toEqual([
      'appBlockId',
      'blockInstanceId',
      'boolProps',
      'enumProps',
      'eventName',
      'isAnon',
      'isOwner',
      'numProps',
      'time',
      'userId',
      'viewerKey',
    ]);
    expect(JSON.stringify(mockInsert.mock.calls)).not.toContain('192.0.2.99');
  });

  it('never writes the client address', async () => {
    await post({ events: [event()] });
    expect(insertedRows()).toHaveLength(1);
    expect(JSON.stringify(mockInsert.mock.calls)).not.toContain('198.51.100');
  });

  it('marks isOwner only for the app owner', async () => {
    sessionStore.session = { user: { id: APP_OWNER } };
    await post({
      events: [event(), event({ appBlockId: OTHER_APP, eventName: 'purchase_started' })],
    });
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    await post({ events: [event()] });
    sessionStore.session = null;
    await post({ events: [event()] });
    expect(insertedRows().map((r) => [r.appBlockId, r.userId, r.isOwner])).toEqual([
      ['apb_arcade', 6611, 1],
      // The same viewer is not the owner of the other app.
      ['apb_shop', 6611, 0],
      ['apb_arcade', 9102, 0],
      ['apb_arcade', 0, 0],
    ]);
  });

  it('resolves the session once per request, however many rows', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    await post({ events: Array.from({ length: 9 }, () => event()) });
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('writes a signed-out row even when no client address resolves, and counts it', async () => {
    const anon = await outcomeDelta(() => post({ events: [event(), event()] }, { ip: null }));
    expect(insertedRows().map((r) => [r.isAnon, r.viewerKey])).toEqual([
      [1, '0'],
      [1, '0'],
    ]);
    expect(anon).toEqual({ accepted: 2, unattested_address: 2 });
  });
});

// ── private runs, the sink and the deployment gate ───────────────────────────

describe('POST /api/track/block-event — what is withheld', () => {
  it('🔴 skips a private run, asking the predicate with the session viewer', async () => {
    const viewer = { id: OTHER_VIEWER };
    sessionStore.session = { user: viewer };
    mockPrivateRun.mockImplementation(async () => true);
    const delta = await outcomeDelta(() => post({ events: [event(), event()] }));
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockPrivateRun).toHaveBeenCalledTimes(1);
    expect(mockPrivateRun).toHaveBeenCalledWith({ appBlockId: 'apb_arcade', viewer });
    expect(delta).toEqual({ private_run: 2 });
  });

  it('skips only the privately run app in a mixed batch', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    mockPrivateRun.mockImplementation(async ({ appBlockId }: { appBlockId: string }) => {
      return appBlockId === OTHER_APP;
    });
    await post({
      events: [event(), event({ appBlockId: OTHER_APP, eventName: 'purchase_started' })],
    });
    expect(insertedRows().map((r) => r.appBlockId)).toEqual(['apb_arcade']);
  });

  it('a ClickHouse failure does not surface, and is counted', async () => {
    mockInsert.mockImplementation(async () => {
      throw new Error('clickhouse down');
    });
    const rejected = await outcomeDelta(async () => {
      expect((await post({ events: [event(), event()] })).status).toHaveBeenCalledWith(200);
    });
    expect(rejected).toEqual({ insert_failed: 2 });

    mockInsert.mockImplementation(() => {
      throw new Error('threw synchronously');
    });
    const thrown = await outcomeDelta(async () => {
      expect((await post({ events: [event()] })).status).toHaveBeenCalledWith(200);
    });
    expect(thrown).toEqual({ insert_failed: 1 });
  });

  it('does nothing harmful when no ClickHouse client is configured', async () => {
    chStore.present = false;
    const delta = await outcomeDelta(async () => {
      expect((await post({ events: [event()] })).status).toHaveBeenCalledWith(200);
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(delta).toEqual({ insert_failed: 1 });
  });

  it.each([
    ['the production signal is absent', { env: undefined }],
    ['the production signal is empty', { env: '' }],
    ['the production signal has another value', { env: 'staging' }],
    ['the production signal differs in case', { env: 'Production' }],
    ['the production signal has whitespace', { env: ' production' }],
    ['IS_PREVIEW is set, despite the signal', { isPreview: true, cacheKeyNamespace: '' }],
    [
      'a cache namespace is set, despite the signal',
      { isPreview: false, cacheKeyNamespace: 'next' },
    ],
  ])('🔴 %s: validates but does not insert', async (_label, signals) => {
    if ('env' in signals) {
      if (signals.env === undefined) vi.stubEnv('CIVITAI_DEPLOYMENT_ENVIRONMENT', undefined);
      else vi.stubEnv('CIVITAI_DEPLOYMENT_ENVIRONMENT', signals.env);
    } else {
      Object.assign(envStore, signals);
    }
    const delta = await outcomeDelta(async () => {
      const res = await post({
        events: [
          event(),
          event({ eventName: 'not_declared' }),
          event({ eventName: 'level_cleared', properties: { seconds: 'slow' } }),
          event({ appBlockId: 'apb_never_approved' }),
        ],
      });
      expect(res.status).toHaveBeenCalledWith(200);
    });
    expect(mockInsert).not.toHaveBeenCalled();
    // The validation path ran in full: the unknown app and the invalid value were classified.
    expect(delta).toEqual({ non_prod_skipped: 3, unknown_app: 1, invalid_value: 1 });
  });

  it('the production deployment (signal exactly "production", no veto) inserts the same batch', async () => {
    expect(process.env.CIVITAI_DEPLOYMENT_ENVIRONMENT).toBe('production');
    const delta = await outcomeDelta(() =>
      post({ events: [event(), event({ eventName: 'not_declared' })] })
    );
    expect(insertedRows()).toHaveLength(2);
    expect(delta).toEqual({ accepted: 1, undeclared_event: 1 });
  });
});

// ── the rate limit ───────────────────────────────────────────────────────────

describe('POST /api/track/block-event — the rate limit', () => {
  const batch = (n: number, over: Record<string, unknown> = {}) => ({
    events: Array.from({ length: n }, () => event(over)),
  });

  it('trips at the burst, drops and counts the excess, and recovers with time', async () => {
    const handler = await loadHandler();
    const delta = await outcomeDelta(async () => {
      await post(batch(50), { handler });
      await post(batch(50), { handler });
      await post(batch(50), { handler });
    });
    expect(insertedRows()).toHaveLength(100);
    expect(delta).toEqual({ accepted: 100, rate_limited: 50 });

    // A partly admitted batch keeps its FIRST rows.
    vi.setSystemTime(DAY_1_NOON + 2_000);
    const numbered = {
      events: Array.from({ length: 50 }, (_, i) => event({ blockInstanceId: `bki_row_${i}` })),
    };
    const later = await outcomeDelta(() => post(numbered, { handler }));
    expect(insertedRows()).toHaveLength(120);
    expect(
      insertedRows()
        .slice(100)
        .map((r) => r.blockInstanceId)
    ).toEqual(Array.from({ length: 20 }, (_, i) => `bki_row_${i}`));
    expect(later).toEqual({ accepted: 20, rate_limited: 30 });
  });

  it('budgets each client address and each app separately', async () => {
    const handler = await loadHandler();
    await post(batch(50), { handler });
    await post(batch(50), { handler });
    await post(batch(50), { handler });
    expect(insertedRows()).toHaveLength(100);

    await post(batch(7), { handler, ip: '203.0.113.200' });
    expect(insertedRows()).toHaveLength(107);
    await post(batch(4, { appBlockId: OTHER_APP, eventName: 'purchase_started' }), { handler });
    expect(insertedRows()).toHaveLength(111);
  });

  it('does not resolve a session for a caller who is entirely over budget', async () => {
    const handler = await loadHandler();
    await post(batch(50), { handler });
    await post(batch(50), { handler });
    mockGetSession.mockClear();
    await post(batch(5), { handler });
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('🔴 a flood of invented app ids creates no buckets', async () => {
    const handler = await loadHandler();
    const limiter: typeof RateLimitModule = await import(
      '~/server/services/blocks/block-event-rate-limit'
    );
    for (let i = 0; i < 40; i += 1) {
      await post(
        {
          events: Array.from({ length: 50 }, (_, j) =>
            event({ appBlockId: `apb_flood_${i}_${j}` })
          ),
        },
        { handler }
      );
    }
    expect(limiter.blockEventRateLimiter().size()).toBe(0);
    // Positive control: the same reader sees a bucket once an approved app is used.
    await post(batch(1), { handler });
    expect(limiter.blockEventRateLimiter().size()).toBe(1);
  });
});

// ── review-driven cases ──────────────────────────────────────────────────────

describe('POST /api/track/block-event — the block instance id', () => {
  it.each([
    ['page_apb_arcade'],
    ['mbi_01HZX3'],
    ['bki_01HZX3'],
    ['bus_pub_01HZX3'],
    ['bus_view_01HZX3'],
    ['pdb_01HZX3'],
  ])('stores the platform-shaped id %s', async (blockInstanceId) => {
    const delta = await outcomeDelta(() => post({ events: [event({ blockInstanceId })] }));
    expect(insertedRows()[0].blockInstanceId).toBe(blockInstanceId);
    expect(delta).toEqual({ accepted: 1 });
  });

  it.each([
    ['free text', 'my diary entry for today'],
    ['an email', 'someone@example.com'],
    ['an unknown prefix', 'note_01HZX3'],
    ['a prefix with nothing after it', 'page_'],
    ['a known prefix followed by punctuation', 'bki_hello world!'],
    ["another app's page id", 'page_apb_shop'],
    ['a page id the caller made up', 'page_anything_i_like'],
  ])('🔴 stores %s as empty and flags the row', async (_label, blockInstanceId) => {
    const delta = await outcomeDelta(() => post({ events: [event({ blockInstanceId })] }));
    expect(insertedRows()).toEqual([
      expect.objectContaining({ blockInstanceId: '', eventName: 'menu_opened' }),
    ]);
    expect(JSON.stringify(mockInsert.mock.calls)).not.toContain(blockInstanceId);
    expect(delta).toEqual({ accepted: 1, invalid_instance_id: 1 });
  });

  it('bounds both ids at 256 characters and trims them', async () => {
    const at = (n: number) => `bki_${'a'.repeat(n - 4)}`;
    expect(
      (await post({ events: [event({ blockInstanceId: at(257) })] })).status
    ).toHaveBeenCalledWith(400);
    expect(
      (await post({ events: [event({ appBlockId: 'a'.repeat(257) })] })).status
    ).toHaveBeenCalledWith(400);
    expect(
      (await post({ events: [event({ blockInstanceId: '   ' })] })).status
    ).toHaveBeenCalledWith(400);
    expect((await post({ events: [event({ appBlockId: '   ' })] })).status).toHaveBeenCalledWith(
      400
    );
    expect(mockInsert).not.toHaveBeenCalled();

    expect(
      (await post({ events: [event({ blockInstanceId: at(256) })] })).status
    ).toHaveBeenCalledWith(200);
    expect(
      (await post({ events: [event({ appBlockId: `  ${APP} `, blockInstanceId: ' bki_x ' })] }))
        .status
    ).toHaveBeenCalledWith(200);
    // 256 passes the schema but is past the stored grammar's length, so it is stored empty.
    expect(insertedRows().map((r) => [r.appBlockId, r.blockInstanceId])).toEqual([
      ['apb_arcade', ''],
      ['apb_arcade', 'bki_x'],
    ]);
  });
});

describe('POST /api/track/block-event — which address is trusted', () => {
  it('🔴 budgets an unattested address header under the shared fallback, not its own', async () => {
    const handler = await loadHandler();
    const batch = { events: Array.from({ length: 50 }, () => event()) };
    // Two full bursts from one attested address use up that address's budget...
    await post(batch, { handler, ip: '198.51.100.23' });
    await post(batch, { handler, ip: '198.51.100.23' });
    expect(insertedRows()).toHaveLength(100);
    // ...the same address WITHOUT the edge's attestation is not that address: it gets the
    // fallback budget, which is still full.
    const delta = await outcomeDelta(() =>
      post(batch, { handler, noEdge: true, ip: '198.51.100.23' })
    );
    expect(insertedRows()).toHaveLength(150);
    expect(delta).toEqual({ accepted: 50, unattested_address: 50 });
  });

  it('flags every unattested row, including the ones the drained fallback budget refuses', async () => {
    const handler = await loadHandler();
    const batch = { events: Array.from({ length: 50 }, () => event()) };
    await post(batch, { handler, noEdge: true });
    await post(batch, { handler, noEdge: true });
    // The fallback bucket is now empty: every row of the next batch is refused AND flagged.
    const delta = await outcomeDelta(() => post(batch, { handler, noEdge: true }));
    expect(insertedRows()).toHaveLength(100);
    expect(delta).toEqual({ rate_limited: 50, unattested_address: 50 });
  });

  it('🔴 does not fall back to the transport peer, which behind a proxy is the proxy', async () => {
    const handler = await loadHandler();
    const batch = { events: Array.from({ length: 50 }, () => event()) };
    // Two different peers without attestation share ONE budget: the peer is not used.
    await post(batch, { handler, noEdge: true, socketIp: '10.20.30.40' });
    await post(batch, { handler, noEdge: true, socketIp: '10.20.30.41' });
    await post(batch, { handler, noEdge: true, socketIp: '10.20.30.42' });
    expect(insertedRows()).toHaveLength(100);
  });

  it('gives callers with no trusted address ONE shared budget, whatever header they send', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    const handler = await loadHandler();
    const batch = { events: Array.from({ length: 50 }, () => event()) };
    await post(batch, { handler, noEdge: true, ip: '192.0.2.1' });
    await post(batch, { handler, noEdge: true, ip: '192.0.2.2' });
    await post(batch, { handler, noEdge: true, ip: '192.0.2.3' });
    expect(insertedRows()).toHaveLength(100);
  });

  it('budgets an IPv6 /64 as one caller, and a different /64 separately', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    const handler = await loadHandler();
    const batch = { events: Array.from({ length: 50 }, () => event()) };
    await post(batch, { handler, ip: '2001:db8:aa:bb::1' });
    await post(batch, { handler, ip: '2001:db8:aa:bb:1234:5678:9abc:def0' });
    await post(batch, { handler, ip: '2001:db8:aa:bb:ffff::2' });
    expect(insertedRows()).toHaveLength(100);
    await post(batch, { handler, ip: '2001:db8:aa:bc::1' });
    expect(insertedRows()).toHaveLength(150);
  });
});

describe('POST /api/track/block-event — failures stay inside', () => {
  it('a session that cannot be resolved drops the rows, counts them and answers 200', async () => {
    mockGetSession.mockImplementation(() => {
      throw new Error('session store down');
    });
    const delta = await outcomeDelta(async () => {
      expect((await post({ events: [event(), event()] })).status).toHaveBeenCalledWith(200);
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(delta).toEqual({ session_failed: 2 });
  });

  it('an unexpected throw on the request path still answers 200', async () => {
    // The real predicate never rejects; this stands in for any defect below the handler.
    mockPrivateRun.mockImplementation(async () => {
      throw new Error('unexpected');
    });
    const res = await post({ events: [event()] });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.status).toHaveBeenCalledTimes(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('log sink down'))],
    [
      'throws synchronously',
      () => {
        throw new Error('log sink broken');
      },
    ],
  ])('🔴 the detached write never rejects, even when the failure log %s', async (_label, impl) => {
    mockInsert.mockImplementation(async () => {
      throw new Error('clickhouse down');
    });
    loggingMock.logToAxiom.mockImplementation(impl);
    const { ingestBlockEvents } = await import(
      '~/server/services/blocks/block-event-ingest.service'
    );
    const { written } = await ingestBlockEvents({
      events: [event()],
      req: {
        headers: { 'cf-connecting-ip': VIEWER_IP, 'cf-ray': 'test-ray' },
      } as unknown as NextApiRequest,
      res: makeRes(),
    });
    await expect(written).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('logs the NAME of a write error, never its message', async () => {
    mockInsert.mockImplementation(async () => {
      throw new TypeError('Cannot parse row: {"eventName":"menu_opened"}');
    });
    await post({ events: [event()] });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      { name: 'app-block-events-insert-failed', type: 'error', rows: 1, error: 'TypeError' },
      'clickhouse'
    );
    expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain('Cannot parse');
  });

  it('aborts a write that is still unanswered after 5 seconds, and not before', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(DAY_1_NOON);
    mockInsert.mockImplementation(() => new Promise<void>(() => undefined));
    await post({ events: [event()] });
    const signal = (mockInsert.mock.calls[0][0] as { abort_signal?: AbortSignal }).abort_signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    vi.advanceTimersByTime(4_999);
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal!.aborted).toBe(true);
  });

  it('does not leave the deadline timer armed after a write that answered', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(DAY_1_NOON);
    await post({ events: [event()] });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('🔴 sheds new batches once 32 writes are in flight, and recovers when they settle', async () => {
    sessionStore.session = { user: { id: OTHER_VIEWER } };
    const release: Array<() => void> = [];
    mockInsert.mockImplementation(() => new Promise<void>((resolve) => release.push(resolve)));
    const handler = await loadHandler();
    // Distinct addresses, so the per-address budget is not what stops them.
    const delta = await outcomeDelta(async () => {
      for (let i = 0; i < 35; i += 1) {
        await post({ events: [event()] }, { handler, ip: `203.0.113.${i + 1}` });
      }
    });
    expect(mockInsert).toHaveBeenCalledTimes(32);
    expect(delta).toEqual({ insert_failed: 3 });

    release.forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
    await post({ events: [event()] }, { handler, ip: '203.0.113.99' });
    expect(mockInsert).toHaveBeenCalledTimes(33);
  });
});
