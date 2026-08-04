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
  throws?: boolean;
  /** Resolve only after `signal` aborts, to exercise the timeout path. */
  hangUntilAborted?: boolean;
}): FakeCh {
  const calls: ChCall[] = [];
  // Pairwise-DISTINCT, and deliberately chosen so anonImpressions (40) EXCEEDS
  // uniqueViewers (9 + 3 = 12). That is the realistic shape — anonymous
  // visitors reload — and an earlier fixture used 4, which stayed below 12 and
  // hid the fact that the two numbers are different units.
  const rollup = opts?.rollup ?? {
    impressions: 124,
    authedViewers: 9,
    anonViewers: 3,
    anonImpressions: 40,
  };
  return {
    calls,
    query: vi.fn(async (arg: ChCall & { abort_signal?: AbortSignal }) => {
      calls.push({ query: arg.query, query_params: arg.query_params });
      if (opts?.throws) throw new Error('clickhouse exploded');
      if (opts?.hangUntilAborted) {
        return new Promise((_resolve, reject) => {
          arg.abort_signal?.addEventListener('abort', () =>
            reject(new Error('The user aborted a request.'))
          );
        });
      }
      return { json: async () => [rollup] };
    }),
  };
}

/** Narrow the fake to the `ch` seam's type at the single call boundary. */
type ChArg = Parameters<typeof getAppViews>[0]['ch'];
const asCh = (ch: FakeCh): ChArg => ch as unknown as ChArg;

const baseArgs = { appBlockIds: IDS, from: FROM, to: TO };

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
    // anonCount is IMPRESSIONS, a different unit — and here deliberately
    // LARGER than uniqueViewers, which is the realistic shape and the one a
    // renderer can misread as "40 of those 12 viewers".
    expect(views.anonCount).toBe(40);
    expect(views.anonCount).toBeGreaterThan(views.uniqueViewers);
  });

  it('coerces ClickHouse string-encoded numbers', async () => {
    // JSONEachRow can hand back 64-bit ints as strings; a missing Number()
    // would turn `count` into a string and `uniqueViewers` into '93'.
    const ch = fakeCh({
      rollup: { impressions: '124', authedViewers: '9', anonViewers: '3', anonImpressions: '40' },
    });

    const views = await getAppViews({ ...baseArgs, ch: asCh(ch) });

    expect(views.count).toBe(124);
    expect(views.uniqueViewers).toBe(12);
    expect(views.anonCount).toBe(40);
  });

  it('survives an empty rollup result set', async () => {
    const ch = fakeCh();
    ch.query.mockImplementation(async () => ({ json: async () => [] }));

    await expect(getAppViews({ ...baseArgs, ch: asCh(ch) })).resolves.toEqual(emptyViews());
  });

  it('issues exactly ONE ClickHouse query per call', async () => {
    // This read sits inside an 11-way Promise.all that AppAnalyticsInline fans
    // out per approved-app row, so a second round-trip is N extra queries per
    // page load. An earlier revision ran a bucketed series query that nothing
    // rendered; this pins that it does not come back unnoticed.
    const ch = fakeCh();
    await getAppViews({ ...baseArgs, ch: asCh(ch) });

    expect(ch.calls).toHaveLength(1);
  });
});

describe('getAppViews — latency is bounded, not just errors', () => {
  it('caps execution SERVER-side and passes an abort signal', async () => {
    const ch = fakeCh();
    await getAppViews({ ...baseArgs, ch: asCh(ch) });

    const arg = ch.query.mock.calls[0][0] as {
      abort_signal?: AbortSignal;
      clickhouse_settings?: { max_execution_time?: number };
    };
    // Client-side abort alone leaves the query running on the cluster, so the
    // server-side cap is the one that actually protects ClickHouse.
    expect(arg.clickhouse_settings?.max_execution_time).toBeGreaterThan(0);
    expect(arg.abort_signal).toBeInstanceOf(AbortSignal);
  });

  it('degrades to UNAVAILABLE when the query hangs past the timeout', async () => {
    // The degrade-don't-throw contract originally covered errors only. A SLOW
    // ClickHouse is the more likely failure: the driver's own request_timeout
    // defaults to five minutes, which would hold the whole Promise.all open.
    const ch = fakeCh({ hangUntilAborted: true });

    const views = await getAppViews({ ...baseArgs, ch: asCh(ch) });

    expect(views).toEqual(unavailableViews());
    expect(views.unavailable).toBe(true);
  }, 30000);
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

  /**
   * 🔴 Pin the WHOLE normalised WHERE clause, not fragments of it.
   *
   * This clause is the only thing that applies tenant isolation to the read.
   * With per-fragment `toContain` assertions, an adversarial sweep flipped
   * `AND` → `OR` (id filter becomes a no-op — every author's impressions) and
   * `IN` → `NOT IN` (every OTHER author's impressions) and BOTH mutants
   * SURVIVED a fully green suite, because each fragment it looked for was
   * still present. Substring matching cannot see boolean structure or
   * polarity; only the whole statement can.
   *
   * The trade is explicit: a cosmetic reformat of the clause fails this test.
   * That is correct — reformatting the one predicate enforcing isolation
   * should require someone to look at it.
   */
  it('pins the ENTIRE isolation predicate, structure and polarity included', async () => {
    const ch = fakeCh();
    await getAppViews({ ...baseArgs, ch: asCh(ch) });

    const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();
    const where = normalise(
      `WHERE appBlockId IN {appBlockIds:Array(String)}
       AND createdDate >= toDate({from:DateTime})
       AND createdDate <= toDate({to:DateTime})
       AND time >= {from:DateTime}
       AND time <= {to:DateTime}`
    );

    expect(ch.calls.length).toBeGreaterThan(0);
    for (const call of ch.calls) {
      expect(normalise(call.query)).toContain(where);
      // Belt and braces on the two mutations that survived fragment matching:
      // a commented-out clause keeps the TEXT present while killing the code.
      expect(call.query).not.toMatch(/--|\/\*/);
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
