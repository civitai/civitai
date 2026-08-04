import { describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the `blockRenders` impression reader.
 *
 * Three things here are contracts rather than implementation details, and each
 * has a defect it is pinning:
 *
 *  1. A MEASURED zero and an UNMEASURED zero must be distinguishable. Returning
 *     bare zeros when ClickHouse is unreachable is the fabricated-zero defect
 *     civitai#3557 / civitai#3581 fixed on the sibling payloads.
 *  2. Unique viewers = distinct authed `userId` PLUS distinct anon `ip`.
 *     Deduping on `blockInstanceId` (which looks per-mount but is per-placement)
 *     or on `userId` alone (anon rows all carry 0) both silently under-count.
 *  3. Values must ride in `query_params`, never string interpolation — the
 *     client's `$query` template formats strings verbatim, so interpolation is
 *     an injection vector.
 *
 * The module-level `clickhouse` import is stubbed to `undefined` so the test
 * never reaches the real env/driver; every positive case injects `ch`
 * explicitly through the seam the service exposes for exactly this.
 */

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(() => Promise.resolve()),
}));

import { getAppViews, emptyViews, unavailableViews } from '../app-views.service';

const IDS = ['apb_one', 'apb_two'];
const FROM = new Date('2026-07-01T00:00:00.000Z');
const TO = new Date('2026-07-31T23:59:59.000Z');

/**
 * A fake ClickHouse client. Records every `query()` call so the tests can
 * assert on the SQL text and the bound params, and answers the rollup and the
 * series by sniffing a token unique to each.
 *
 * Fixture values are pairwise DISTINCT on purpose: if the mapping ever swaps
 * two fields (anonImpressions for anonViewers, say) the assertions must fail
 * rather than coincide.
 */
type ChCall = { query: string; query_params: Record<string, unknown> };
type FakeCh = { calls: ChCall[]; query: ReturnType<typeof vi.fn> };

function fakeCh(opts?: {
  rollup?: Record<string, unknown>;
  series?: unknown[];
  throws?: boolean;
}): FakeCh {
  const calls: ChCall[] = [];
  const rollup = opts?.rollup ?? {
    impressions: 124,
    authedViewers: 9,
    anonViewers: 3,
    anonImpressions: 4,
  };
  const series = opts?.series ?? [
    { bucketTs: 1782864000, value: 11 }, // 2026-07-01T00:00:00Z
    { bucketTs: 1782950400, value: 7 }, // 2026-07-02T00:00:00Z
  ];
  return {
    calls,
    query: vi.fn(async (arg: ChCall) => {
      calls.push({ query: arg.query, query_params: arg.query_params });
      if (opts?.throws) throw new Error('clickhouse exploded');
      const isSeries = arg.query.includes('bucketTs');
      return { json: async () => (isSeries ? series : [rollup]) };
    }),
  };
}

/** Narrow the fake to the `ch` seam's type at the single call boundary. */
type ChArg = Parameters<typeof getAppViews>[0]['ch'];
const asCh = (ch: FakeCh): ChArg => ch as unknown as ChArg;

const baseArgs = { appBlockIds: IDS, from: FROM, to: TO, granularity: 'day' as const };

describe('getAppViews — measured vs unmeasured zeros', () => {
  it('returns a MEASURED zero (no flag) when the caller owns no apps', async () => {
    const ch = fakeCh();
    const views = await getAppViews({ ...baseArgs, appBlockIds: [], ch: asCh(ch) });

    expect(views).toEqual(emptyViews());
    // The distinguishing assertion: absent, not false. A client branches on it.
    expect(views.unavailable).toBeUndefined();
    // Owning nothing must not cost a query.
    expect(ch.calls).toHaveLength(0);
  });

  it('returns an UNMEASURED zero when ClickHouse is not configured', async () => {
    const views = await getAppViews({ ...baseArgs, ch: undefined });

    expect(views).toEqual(unavailableViews());
    expect(views.unavailable).toBe(true);
    expect(views.count).toBe(0);
  });

  it('degrades to an UNMEASURED zero when the query throws, and never rethrows', async () => {
    const ch = fakeCh({ throws: true });

    // The whole point: one flaky store must not take down the analytics panel.
    await expect(getAppViews({ ...baseArgs, ch: asCh(ch) })).resolves.toEqual(unavailableViews());
  });

  it('a real all-zero result is NOT flagged unavailable', async () => {
    const ch = fakeCh({
      rollup: { impressions: 0, authedViewers: 0, anonViewers: 0, anonImpressions: 0 },
      series: [],
    });

    const views = await getAppViews({ ...baseArgs, ch: asCh(ch) });

    // Genuinely measured "nobody looked yet" — byte-distinguishable from the
    // outage case above, which is the entire contract.
    expect(views).toEqual(emptyViews());
    expect(views.unavailable).toBeUndefined();
  });
});

describe('getAppViews — aggregation', () => {
  it('sums authenticated and anonymous viewers into uniqueViewers', async () => {
    const ch = fakeCh();
    const views = await getAppViews({ ...baseArgs, ch: asCh(ch) });

    expect(views.count).toBe(124);
    // 9 distinct authed userIds + 3 distinct anon ips. NOT 9 (userId only,
    // which drops anon) and NOT 12 by coincidence of equal fixtures.
    expect(views.uniqueViewers).toBe(12);
    expect(views.anonCount).toBe(4);
  });

  it('maps the series buckets to ISO timestamps', async () => {
    const ch = fakeCh();
    const views = await getAppViews({ ...baseArgs, ch: asCh(ch) });

    expect(views.series).toEqual([
      { bucket: '2026-07-01T00:00:00.000Z', value: 11 },
      { bucket: '2026-07-02T00:00:00.000Z', value: 7 },
    ]);
  });

  it('coerces ClickHouse string-encoded numbers', async () => {
    // JSONEachRow can hand back 64-bit ints as strings; a missing Number()
    // would turn `count` into a string and `uniqueViewers` into '93'.
    const ch = fakeCh({
      rollup: { impressions: '124', authedViewers: '9', anonViewers: '3', anonImpressions: '4' },
      series: [{ bucketTs: '1782864000', value: '11' }],
    });

    const views = await getAppViews({ ...baseArgs, ch: asCh(ch) });

    expect(views.count).toBe(124);
    expect(views.uniqueViewers).toBe(12);
    expect(views.series[0]).toEqual({ bucket: '2026-07-01T00:00:00.000Z', value: 11 });
  });

  it('survives an empty rollup result set', async () => {
    const ch = fakeCh({ rollup: undefined, series: [] });
    ch.query.mockImplementation(async () => ({ json: async () => [] }));

    await expect(getAppViews({ ...baseArgs, ch: asCh(ch) })).resolves.toEqual(emptyViews());
  });
});

describe('getAppViews — query construction', () => {
  it('binds every value through query_params instead of interpolating', async () => {
    const ch = fakeCh();
    await getAppViews({ ...baseArgs, ch: asCh(ch) });

    expect(ch.calls.length).toBeGreaterThan(0);
    for (const call of ch.calls) {
      // The placeholder is present...
      expect(call.query).toContain('{appBlockIds:Array(String)}');
      // ...and the literal id never appears in the SQL text. This is the
      // injection guard: `$query` would have formatted it verbatim.
      expect(call.query).not.toContain('apb_one');
      expect(call.query_params.appBlockIds).toEqual(IDS);
      expect(call.query_params.from).toBe('2026-07-01 00:00:00');
      expect(call.query_params.to).toBe('2026-07-31 23:59:59');
    }
  });

  it('buckets by day at day granularity', async () => {
    const ch = fakeCh();
    await getAppViews({ ...baseArgs, granularity: 'day', ch: asCh(ch) });

    const series = ch.calls.find((c) => c.query.includes('bucketTs'));
    expect(series?.query).toContain('toStartOfDay(time)');
  });

  it('buckets weeks from MONDAY so the series aligns with the Postgres one', async () => {
    const ch = fakeCh();
    await getAppViews({ ...baseArgs, granularity: 'week', ch: asCh(ch) });

    const series = ch.calls.find((c) => c.query.includes('bucketTs'));
    // Mode 1 is load-bearing: ClickHouse defaults to Sunday, Postgres
    // date_trunc('week') is Monday. Bare toStartOfWeek(time) draws the views
    // line a day out of phase with runs/installs on the same chart.
    expect(series?.query).toContain('toStartOfWeek(time, 1)');
    expect(series?.query).not.toMatch(/toStartOfWeek\(time\)/);
  });

  it('bounds the partition key as well as the timestamp', async () => {
    const ch = fakeCh();
    await getAppViews({ ...baseArgs, ch: asCh(ch) });

    for (const call of ch.calls) {
      // Without the createdDate bounds the scan reads every partition.
      expect(call.query).toContain('createdDate >= toDate({from:DateTime})');
      expect(call.query).toContain('createdDate <= toDate({to:DateTime})');
      expect(call.query).toContain('time >= {from:DateTime}');
      expect(call.query).toContain('time <= {to:DateTime}');
    }
  });

  it('separates anonymous from authenticated viewers in the rollup', async () => {
    const ch = fakeCh();
    await getAppViews({ ...baseArgs, ch: asCh(ch) });

    const rollup = ch.calls.find((c) => !c.query.includes('bucketTs'));
    expect(rollup?.query).toContain('uniqExactIf(userId, isAnon = 0)');
    expect(rollup?.query).toContain('uniqExactIf(ip, isAnon = 1)');
    // Never dedup on blockInstanceId — it is per-placement, ~1:1 with the app.
    expect(rollup?.query).not.toContain('blockInstanceId');
  });
});
