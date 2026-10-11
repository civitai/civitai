import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as AppAnalyticsModule from '../app-analytics.service';

/**
 * The owner read of `appBlockEvents`. The SQL is pinned WHOLE because each clause is a privacy or
 * correctness contract a fragment match would let a mutant keep: the owner exclusion (which
 * also governs the drop count), signed-in-only uniques (`viewerKey != 0`), and the
 * `mapContains` gate on every property aggregate (an absent Map key reads as 0).
 */

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
const { mockGetOwnedAppBlocks } = vi.hoisted(() => ({ mockGetOwnedAppBlocks: vi.fn() }));
vi.mock('../app-analytics.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAnalyticsModule>()),
  getOwnedAppBlocks: (...a: unknown[]) => mockGetOwnedAppBlocks(...a),
}));
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  CUSTOM_EVENTS_QUERY_TIMEOUT_SECONDS,
  getAppCustomEvents,
  getMyAppCustomEvents,
} from '../app-custom-events.service';

const APP = 'apb_custom';
const RANGE_DAY = {
  from: new Date('2026-07-01T00:00:00.000Z'),
  to: new Date('2026-07-31T12:34:56.789Z'),
  granularity: 'day' as const,
};
const RANGE_WEEK = { ...RANGE_DAY, granularity: 'week' as const };

const MANIFEST = {
  analytics: {
    events: {
      generate_clicked: {
        description: 'User pressed Generate',
        properties: {
          mode: { type: 'enum', values: ['txt2img', 'img2img', 'inpaint'] },
          batch: { type: 'number' },
          advanced: { type: 'boolean' },
        },
      },
      share_clicked: {},
      never_sent: {},
    },
  },
};

const WHERE =
  'WHERE appBlockId = {appBlockId:String} AND time >= {from:DateTime64(3)} AND time <= {to:DateTime64(3)}';
const OWNERLESS = `${WHERE} AND isOwner = 0`;

const topSql = (where: string, uniq: string) =>
  `SELECT eventName, count() AS events, ${uniq}(viewerKey, viewerKey != 0) AS signedInViewers, countIf(viewerKey = 0) AS anonymousEvents FROM appBlockEvents ${where} AND eventName IN {eventNames:Array(String)} GROUP BY eventName LIMIT 100`;
const seriesSql = (where: string, bucket: string) =>
  `SELECT ${bucket} AS bucket, count() AS value FROM appBlockEvents ${where} AND eventName = {event:String} GROUP BY bucket ORDER BY bucket LIMIT 400`;
const scalarSql = (where: string) =>
  `SELECT countIf(mapContains(numProps, {n0:String})) AS n0_count, sumIf(numProps[{n0:String}], mapContains(numProps, {n0:String})) AS n0_sum, avgIf(numProps[{n0:String}], mapContains(numProps, {n0:String})) AS n0_avg, quantilesTDigestIf(0.5, 0.95)(numProps[{n0:String}], mapContains(numProps, {n0:String})) AS n0_q, countIf(mapContains(boolProps, {b0:String}) AND boolProps[{b0:String}] = 1) AS b0_true, countIf(mapContains(boolProps, {b0:String}) AND boolProps[{b0:String}] = 0) AS b0_false FROM appBlockEvents ${where} AND eventName = {event:String}`;
const enumSql = (where: string) =>
  `SELECT property, value, count() AS events FROM appBlockEvents ARRAY JOIN mapKeys(enumProps) AS property, mapValues(enumProps) AS value ${where} AND eventName = {event:String} AND property IN {enumNames:Array(String)} GROUP BY property, value LIMIT 1000`;

const BASE_PARAMS = {
  appBlockId: APP,
  from: '2026-07-01 00:00:00.000',
  to: '2026-07-31 12:34:56.789',
};

type ChCall = {
  query: string;
  query_params: Record<string, unknown>;
  format?: string;
  abort_signal?: AbortSignal;
  clickhouse_settings?: Record<string, unknown>;
};

/** Answers each query by its shape; owner rows are modelled, so a query without the owner exclusion sees more. */
function fakeCh(opts?: {
  throws?: boolean;
  failDetail?: boolean;
  failTop?: boolean;
  hangDetailUntilAborted?: boolean;
  hangUntilAborted?: boolean;
  scalar?: unknown;
}) {
  const calls: ChCall[] = [];
  const query = vi.fn(async (arg: ChCall) => {
    calls.push(arg);
    if (opts?.throws) throw new Error('clickhouse exploded');
    if (opts?.hangUntilAborted) {
      return new Promise((_resolve, reject) => {
        arg.abort_signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const isTop = arg.query.includes('AS signedInViewers');
    if (opts?.failTop && isTop) throw new Error('top read failed');
    if (opts?.hangDetailUntilAborted && !isTop) {
      return new Promise((_resolve, reject) => {
        arg.abort_signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (opts?.failDetail && !isTop) {
      throw new Error('memory limit exceeded');
    }
    const ownerExcluded = arg.query.includes(' AND isOwner = 0');
    let rows: unknown[] = [];
    if (arg.query.includes('AS signedInViewers')) {
      rows = [
        {
          eventName: 'generate_clicked',
          events: ownerExcluded ? '57' : '60',
          signedInViewers: ownerExcluded ? '13' : '14',
          anonymousEvents: '21',
        },
        { eventName: 'share_clicked', events: '8', signedInViewers: '5', anonymousEvents: '2' },
        {
          eventName: '__undeclared__',
          events: ownerExcluded ? '3' : '11',
          signedInViewers: '0',
          anonymousEvents: '3',
        },
      ];
    } else if (arg.query.includes('AS bucket')) {
      rows = [
        { bucket: '2026-07-06', value: '9' },
        { bucket: '2026-07-13', value: '4' },
      ];
    } else if (arg.query.includes('n0_count')) {
      rows = [
        opts?.scalar ?? {
          n0_count: '3',
          n0_sum: 16,
          n0_avg: 5.25,
          n0_q: [4, 10],
          b0_true: '6',
          b0_false: '1',
        },
      ];
    } else if (arg.query.includes('ARRAY JOIN')) {
      rows = [
        { property: 'mode', value: 'img2img', events: '7' },
        { property: 'mode', value: 'txt2img', events: '12' },
      ];
    }
    return { json: async () => rows };
  });
  return { calls, query };
}

type ChArg = Parameters<typeof getAppCustomEvents>[0]['ch'];
const asCh = (ch: ReturnType<typeof fakeCh>): ChArg => ch as unknown as ChArg;
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const sqls = (ch: ReturnType<typeof fakeCh>) => ch.calls.map((c) => norm(c.query));

afterEach(() => {
  vi.useRealTimers();
});

describe('getAppCustomEvents: SQL', () => {
  it('default: every query excludes owner rows, uniques are signed-in only, props gate on mapContains', async () => {
    const ch = fakeCh();
    await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_DAY,
      event: 'generate_clicked',
      ch: asCh(ch),
    });
    expect(sqls(ch)).toEqual([
      topSql(OWNERLESS, 'uniqExactIf'),
      seriesSql(OWNERLESS, "toDate(time, 'UTC')"),
      scalarSql(OWNERLESS),
      enumSql(OWNERLESS),
    ]);
  });

  it('includeOwner: no query carries the owner exclusion', async () => {
    const ch = fakeCh();
    await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_DAY,
      includeOwner: true,
      event: 'generate_clicked',
      ch: asCh(ch),
    });
    expect(sqls(ch)).toEqual([
      topSql(WHERE, 'uniqExactIf'),
      seriesSql(WHERE, "toDate(time, 'UTC')"),
      scalarSql(WHERE),
      enumSql(WHERE),
    ]);
  });

  it('a week-bucketed range (>60 days) keeps exact uniques and buckets by Monday weeks', async () => {
    const ch = fakeCh();
    await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_WEEK,
      event: 'share_clicked',
      ch: asCh(ch),
    });
    expect(sqls(ch)).toEqual([
      topSql(OWNERLESS, 'uniqExactIf'),
      seriesSql(OWNERLESS, "toStartOfWeek(time, 1, 'UTC')"),
    ]);
  });

  it('binds every value as a parameter: the app, the range, the declared names and the event', async () => {
    const ch = fakeCh();
    await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_DAY,
      event: 'generate_clicked',
      ch: asCh(ch),
    });
    expect(ch.calls.map((c) => c.query_params)).toEqual([
      {
        ...BASE_PARAMS,
        eventNames: ['generate_clicked', 'share_clicked', 'never_sent', '__undeclared__'],
      },
      { ...BASE_PARAMS, event: 'generate_clicked' },
      { ...BASE_PARAMS, event: 'generate_clicked', n0: 'batch', b0: 'advanced' },
      { ...BASE_PARAMS, event: 'generate_clicked', enumNames: ['mode'] },
    ]);
    for (const call of ch.calls) {
      expect(call.query).not.toContain(APP);
      expect(call.query).not.toContain("'generate_clicked'");
      expect(call.format).toBe('JSONEachRow');
      expect(call.abort_signal).toBeInstanceOf(AbortSignal);
      expect(call.clickhouse_settings).toEqual({ max_execution_time: 10 });
    }
  });

  it('an event the manifest does not declare is never queried', async () => {
    const ch = fakeCh();
    const result = await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_DAY,
      event: 'not_declared',
      ch: asCh(ch),
    });
    expect(ch.calls).toHaveLength(1);
    expect(JSON.stringify(ch.calls[0].query_params)).not.toContain('not_declared');
    expect(result.selected).toBeUndefined();
  });
});

describe('getAppCustomEvents: results', () => {
  it('maps the top events (declared-but-zero included, drops excluded) and the selected event', async () => {
    const ch = fakeCh();
    const result = await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_DAY,
      event: 'generate_clicked',
      ch: asCh(ch),
    });
    expect(result).toEqual({
      declared: [
        {
          name: 'generate_clicked',
          description: 'User pressed Generate',
          properties: [
            { name: 'mode', type: 'enum', values: ['txt2img', 'img2img', 'inpaint'] },
            { name: 'batch', type: 'number' },
            { name: 'advanced', type: 'boolean' },
          ],
        },
        { name: 'share_clicked', properties: [] },
        { name: 'never_sent', properties: [] },
      ],
      includeOwner: false,
      topEvents: [
        { eventName: 'generate_clicked', count: 57, signedInViewers: 13, anonymousEvents: 21 },
        { eventName: 'share_clicked', count: 8, signedInViewers: 5, anonymousEvents: 2 },
        { eventName: 'never_sent', count: 0, signedInViewers: 0, anonymousEvents: 0 },
      ],
      undeclaredDrops: 3,
      selected: {
        eventName: 'generate_clicked',
        series: [
          { bucket: '2026-07-06T00:00:00.000Z', value: 9 },
          { bucket: '2026-07-13T00:00:00.000Z', value: 4 },
        ],
        properties: [
          {
            name: 'mode',
            type: 'enum',
            values: [
              { value: 'txt2img', count: 12 },
              { value: 'img2img', count: 7 },
              { value: 'inpaint', count: 0 },
            ],
          },
          { name: 'batch', type: 'number', count: 3, sum: 16, avg: 5.25, p50: 4, p95: 10 },
          { name: 'advanced', type: 'boolean', trueCount: 6, falseCount: 1 },
        ],
      },
    });
  });

  it('the drop count follows the owner toggle (dev-tunnel rows land as __undeclared__)', async () => {
    const excluded = await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_DAY,
      ch: asCh(fakeCh()),
    });
    const included = await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_DAY,
      includeOwner: true,
      ch: asCh(fakeCh()),
    });
    expect(excluded.undeclaredDrops).toBe(3);
    expect(included.undeclaredDrops).toBe(11);
    expect(excluded.topEvents[0].count).toBe(57);
    expect(included.topEvents[0].count).toBe(60);
    expect(included.includeOwner).toBe(true);
  });

  it('a number property no event carried reports nulls, not ClickHouse NaN-as-null zeros', async () => {
    const ch = fakeCh({
      scalar: {
        n0_count: '0',
        n0_sum: 0,
        n0_avg: null,
        n0_q: [null, null],
        b0_true: '0',
        b0_false: '0',
      },
    });
    const result = await getAppCustomEvents({
      appBlockId: APP,
      manifest: MANIFEST,
      range: RANGE_DAY,
      event: 'generate_clicked',
      ch: asCh(ch),
    });
    expect(result.selected?.properties[1]).toEqual({
      name: 'batch',
      type: 'number',
      count: 0,
      sum: 0,
      avg: null,
      p50: null,
      p95: null,
    });
  });

  it('an app that declares nothing still reads its drop count', async () => {
    const ch = fakeCh();
    const result = await getAppCustomEvents({
      appBlockId: APP,
      manifest: { page: { path: '/' } },
      range: RANGE_DAY,
      ch: asCh(ch),
    });
    expect(ch.calls[0].query_params.eventNames).toEqual(['__undeclared__']);
    expect(result).toEqual({
      declared: [],
      includeOwner: false,
      topEvents: [],
      undeclaredDrops: 3,
    });
  });
});

describe('getAppCustomEvents: never throws', () => {
  const args = { appBlockId: APP, manifest: MANIFEST, range: RANGE_DAY, event: 'generate_clicked' };
  const UNAVAILABLE = {
    includeOwner: false,
    topEvents: [],
    undeclaredDrops: 0,
    unavailable: true,
  };

  it('ClickHouse not configured: unavailable, declarations kept', async () => {
    const result = await getAppCustomEvents({ ...args, ch: undefined });
    expect(result).toEqual({ ...UNAVAILABLE, declared: expect.any(Array) });
    expect(result.declared.map((d) => d.name)).toEqual([
      'generate_clicked',
      'share_clicked',
      'never_sent',
    ]);
  });

  it('a failing query: unavailable, not a zero', async () => {
    await expect(
      getAppCustomEvents({ ...args, ch: asCh(fakeCh({ throws: true })) })
    ).resolves.toEqual({ ...UNAVAILABLE, declared: expect.any(Array) });
  });

  it('the queries of one call succeed or fail together: a failing detail read is unavailable', async () => {
    await expect(
      getAppCustomEvents({ ...args, ch: asCh(fakeCh({ failDetail: true })) })
    ).resolves.toEqual({ ...UNAVAILABLE, declared: expect.any(Array) });
  });

  it('a failed top read aborts the detail queries still in flight, and logs once', async () => {
    loggingMock.logToAxiom.mockClear();
    const ch = fakeCh({ failTop: true, hangDetailUntilAborted: true });
    const result = await getAppCustomEvents({ ...args, ch: asCh(ch) });
    expect(result.unavailable).toBe(true);
    const detailCalls = ch.calls.filter((c) => !c.query.includes('AS signedInViewers'));
    expect(detailCalls).toHaveLength(3);
    for (const call of detailCalls) expect(call.abort_signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      loggingMock.logToAxiom.mock.calls.map((c) => (c[0] as { message: string }).message)
    ).toEqual(['appBlockEvents read failed']);
  });

  it('a detail read that hangs to the timeout, beside a top read that succeeded, logs exactly once', async () => {
    vi.useFakeTimers();
    loggingMock.logToAxiom.mockClear();
    const ch = fakeCh({ hangDetailUntilAborted: true });
    const pending = getAppCustomEvents({ ...args, ch: asCh(ch) });
    await vi.advanceTimersByTimeAsync(CUSTOM_EVENTS_QUERY_TIMEOUT_SECONDS * 1000);
    await expect(pending).resolves.toEqual({ ...UNAVAILABLE, declared: expect.any(Array) });
    await vi.advanceTimersByTimeAsync(1);
    expect(ch.calls).toHaveLength(4);
    expect(
      loggingMock.logToAxiom.mock.calls.map((c) => (c[0] as { message: string }).message)
    ).toEqual(['appBlockEvents read failed']);
  });

  it('a hung query is aborted at the timeout and reads as unavailable', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = getAppCustomEvents({
      ...args,
      ch: asCh(fakeCh({ hangUntilAborted: true })),
    }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(CUSTOM_EVENTS_QUERY_TIMEOUT_SECONDS * 1000 - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ...UNAVAILABLE, declared: expect.any(Array) });
  });
});

describe('getMyAppCustomEvents: ownership and range', () => {
  const NOW = new Date('2026-07-31T00:00:00.000Z');
  const DEFAULT_RANGE = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: NOW,
    granularity: 'day',
  };

  it('an app the caller cannot see: denied, and no ClickHouse query runs', async () => {
    mockGetOwnedAppBlocks.mockReset().mockResolvedValue([]);
    const ch = fakeCh();
    const result = await getMyAppCustomEvents({
      userId: 42,
      appBlockId: 'apb_foreign',
      now: NOW,
      ch: asCh(ch),
    });
    expect(mockGetOwnedAppBlocks).toHaveBeenCalledWith({
      ownerUserId: 42,
      appBlockId: 'apb_foreign',
    });
    expect(ch.calls).toHaveLength(0);
    expect(result).toEqual({
      declared: [],
      includeOwner: false,
      topEvents: [],
      undeclaredDrops: 0,
      unavailable: true,
      range: DEFAULT_RANGE,
      denied: 'notOwned',
    });
  });

  it("an owned app: reads THAT app with its manifest over the panel's resolved range", async () => {
    mockGetOwnedAppBlocks.mockReset().mockResolvedValue([{ id: APP, manifest: MANIFEST }]);
    const ch = fakeCh();
    const result = await getMyAppCustomEvents({
      userId: 42,
      appBlockId: APP,
      now: NOW,
      includeOwner: true,
      event: 'share_clicked',
      ch: asCh(ch),
    });
    expect(result.range).toEqual(DEFAULT_RANGE);
    expect(result.includeOwner).toBe(true);
    expect(result.denied).toBeUndefined();
    expect(result.selected?.eventName).toBe('share_clicked');
    expect(ch.calls[0].query_params).toMatchObject({
      appBlockId: APP,
      from: '2026-07-01 00:00:00.000',
      to: '2026-07-31 00:00:00.000',
    });
    expect(norm(ch.calls[0].query)).toBe(topSql(WHERE, 'uniqExactIf'));
  });
});
