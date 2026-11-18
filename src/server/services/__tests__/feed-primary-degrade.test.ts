import promClient from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_PRIMARY_TIMEOUT_MS, serveFromFeed } from '../feed-primary.service';
import type { FeedPrimaryDeps } from '../feed-primary.service';
import type { CapturableSearchInput } from '../feed-request-capture.service';
import type { FeedAnswer } from '../feed-shadow.service';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The feed service is the image feed's only source once the search index is retired, so its
 * failure modes are the feed's. These drive serveFromFeed with a feed stub that fails on demand.
 * The breaker and the last-good cache sit behind the `feed-service-degrade` flag; the numbers
 * below are written out, not imported, so a changed bound has to change a test too.
 */

// The suite setup stubs ~/server/prom/client with metrics that record nothing; the real helpers
// register on prom-client's default registry, so the caller-side histogram can be read back.
vi.mock('~/server/prom/client', async () => await vi.importActual('@civitai/telemetry/client'));

// `read` lists every flag key evaluated, so a test can show a key is never read at all.
const flag = vi.hoisted(() => ({ on: true, read: [] as string[] }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFliptSync: (key: string) => {
      flag.read.push(key);
      // The retired budget off-switch answers "on" here; the timeout test asserts it is never read.
      if (key === 'feed-service-timeout-widen') return true;
      return key === 'feed-service-degrade' ? flag.on : actual.isFliptSync(key as never);
    },
  };
});

// The breaker needs this many calls in its window, and more than half of them failing.
const MIN_CALLS = 20;
const COOLDOWN_MS = 15_000;
const TTL_MS = 10 * 60_000;

const anon = { sort: 'Most Reactions', period: 'Week', browsingLevel: 31, limit: 100 };
const answer = (ids: number[], extra: Partial<FeedAnswer> = {}): FeedAnswer => ({
  status: 200,
  ms: 7,
  ids,
  ...extra,
});
const rows = (ids: number[]) => ids.map((id) => ({ id, url: `u${id}` }));
const hydrate = vi.fn(async (ids: number[]) => rows(ids));
const down = () => vi.fn(async (): Promise<FeedAnswer> => Promise.reject(new Error('refused')));

beforeEach(() => {
  flag.on = true;
  flag.read = [];
  // Fresh breaker, cache and flag gate per test.
  delete (globalThis as { __civitaiFeedDegradeState?: unknown }).__civitaiFeedDegradeState;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
  hydrate.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('feed-service request timeout', () => {
  it('asks the feed with a 5s budget and reads no flag for it', async () => {
    expect(FEED_PRIMARY_TIMEOUT_MS).toBe(5_000);
    const fetchFeed = vi.fn<FeedPrimaryDeps<{ id: number }>['fetchFeed']>(async () => answer([1]));
    await serveFromFeed(anon, { fetchFeed, hydrate });
    // A flag gate is re-read at most every 5s; a second call past that would see any change.
    vi.setSystemTime(Date.now() + 5_001);
    await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed.mock.calls.map((c) => c[1])).toEqual([5_000, 5_000]);
    expect(flag.read).toContain('feed-service-degrade');
    expect(flag.read).not.toContain('feed-service-timeout-widen');
  });
});

describe('caller-side feed time', () => {
  const HIST = 'civitai_app_feed_primary_fetch_duration_seconds';
  type Sample = { metricName?: string; labels: Record<string, string | number>; value: number };
  const sample = async (suffix: 'sum' | 'count', labels: Record<string, string>) => {
    const metric = promClient.register.getSingleMetric(HIST);
    if (!metric) throw new Error(`metric ${HIST} is not registered`);
    const values = (await metric.get()).values as Sample[];
    return values.find(
      (v) =>
        v.metricName === `${HIST}_${suffix}` &&
        Object.entries(labels).every(([k, want]) => v.labels[k] === want)
    )?.value;
  };
  beforeEach(() => promClient.register.getSingleMetric(HIST)?.reset());

  it("records the call's wall-clock time, not the ms the answer reports", async () => {
    // The clock moves 1.234s during the call; the answer claims 321ms.
    const fetchFeed = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 1_234);
      return answer([1], { ms: 321 });
    });
    await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(await sample('count', { route: 'website', outcome: 'ok' })).toBe(1);
    expect(await sample('sum', { route: 'website', outcome: 'ok' })).toBeCloseTo(1.234, 6);
  });

  it('records a timed-out call under its route and outcome', async () => {
    const fetchFeed = vi.fn(async (): Promise<FeedAnswer> => {
      vi.setSystemTime(Date.now() + 4_321);
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    });
    await serveFromFeed(anon, { fetchFeed, hydrate, route: 'rest' });
    expect(await sample('count', { route: 'rest', outcome: 'timeout' })).toBe(1);
    expect(await sample('sum', { route: 'rest', outcome: 'timeout' })).toBeCloseTo(4.321, 6);
    expect(await sample('count', { route: 'website', outcome: 'ok' })).toBeUndefined();
  });
});

describe('feed-service circuit breaker', () => {
  it('does not open on a few failing calls among many good ones', async () => {
    let n = 0;
    // One call in four fails: a single client repeating a query the feed cannot answer.
    const fetchFeed = vi.fn(async () =>
      n++ % 4 === 3 ? Promise.reject(new Error('x')) : answer([1])
    );
    for (let i = 0; i < MIN_CALLS * 3; i++) await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS * 3);
  });

  it('opens once more than half of at least 20 calls in the window failed', async () => {
    // Signed in, so the good calls leave no last-good page to answer the open breaker with.
    const viewer = { ...anon, currentUserId: 7 };
    const fetchFeed = vi.fn(async () => answer([1]));
    for (let i = 0; i < 9; i++) await serveFromFeed(viewer, { fetchFeed, hydrate });
    fetchFeed.mockRejectedValue(new Error('refused'));
    for (let i = 0; i < 11; i++) await serveFromFeed(viewer, { fetchFeed, hydrate });
    expect(fetchFeed).toHaveBeenCalledTimes(20);
    expect(await serveFromFeed(viewer, { fetchFeed, hydrate })).toEqual({
      ok: false,
      reason: 'breaker',
    });
    expect(fetchFeed).toHaveBeenCalledTimes(20);
  });

  it('never opens on fewer calls than the minimum, however many fail', async () => {
    const fetchFeed = down();
    for (let i = 0; i < MIN_CALLS - 1; i++) await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(await serveFromFeed(anon, { fetchFeed, hydrate })).toEqual({
      ok: false,
      reason: 'error',
    });
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS);
  });

  it(`opens after ${MIN_CALLS} failing calls and stops calling the feed`, async () => {
    const fetchFeed = down();
    for (let i = 0; i < MIN_CALLS; i++)
      expect(await serveFromFeed(anon, { fetchFeed, hydrate })).toEqual({
        ok: false,
        reason: 'error',
      });
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS);

    const started = performance.now();
    const r = await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(performance.now() - started).toBeLessThan(50);
    expect(r).toEqual({ ok: false, reason: 'breaker' });
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS);
  });

  it('counts 5xx answers and not 4xx ones', async () => {
    const refused = vi.fn(async () => answer([], { status: 400 }));
    for (let i = 0; i < MIN_CALLS + 5; i++)
      await serveFromFeed(anon, { fetchFeed: refused, hydrate });
    expect(refused).toHaveBeenCalledTimes(MIN_CALLS + 5);

    delete (globalThis as { __civitaiFeedDegradeState?: unknown }).__civitaiFeedDegradeState;
    const sick = vi.fn(async () => answer([], { status: 503 }));
    for (let i = 0; i < MIN_CALLS; i++) await serveFromFeed(anon, { fetchFeed: sick, hydrate });
    expect(await serveFromFeed(anon, { fetchFeed: sick, hydrate })).toEqual({
      ok: false,
      reason: 'breaker',
    });
    expect(sick).toHaveBeenCalledTimes(MIN_CALLS);
  });

  it('does not open on failures spread wider than the window', async () => {
    const fetchFeed = down();
    for (let i = 0; i < MIN_CALLS * 2; i++) {
      await serveFromFeed(anon, { fetchFeed, hydrate });
      // 2.1s apart: 15 calls fit in the 30s window, fewer than the minimum; 29 would fit in 60s.
      vi.setSystemTime(Date.now() + 2_100);
    }
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS * 2);
  });

  it('half-opens after the cooldown: one trial, closing on success', async () => {
    const fetchFeed = down();
    for (let i = 0; i < MIN_CALLS; i++) await serveFromFeed(anon, { fetchFeed, hydrate });
    vi.setSystemTime(Date.now() + COOLDOWN_MS - 1);
    await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS);

    vi.setSystemTime(Date.now() + 1);
    fetchFeed.mockResolvedValue(answer([4]));
    expect((await serveFromFeed(anon, { fetchFeed, hydrate })).ok).toBe(true);
    expect((await serveFromFeed(anon, { fetchFeed, hydrate })).ok).toBe(true);
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS + 2);
  });

  it('lets one trial through at a time, and re-opens when it fails', async () => {
    const fetchFeed = down();
    for (let i = 0; i < MIN_CALLS; i++) await serveFromFeed(anon, { fetchFeed, hydrate });
    vi.setSystemTime(Date.now() + COOLDOWN_MS);

    let settle: (a: FeedAnswer) => void = () => undefined;
    fetchFeed.mockImplementationOnce(() => new Promise((res) => (settle = res)));
    const trial = serveFromFeed(anon, { fetchFeed, hydrate });
    expect(await serveFromFeed(anon, { fetchFeed, hydrate })).toEqual({
      ok: false,
      reason: 'breaker',
    });
    settle(answer([], { status: 502 }));
    expect(await trial).toEqual({ ok: false, reason: 'status:502' });
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS + 1);

    // Re-opened: a fresh cooldown before the next trial.
    vi.setSystemTime(Date.now() + COOLDOWN_MS - 1);
    expect(await serveFromFeed(anon, { fetchFeed, hydrate })).toEqual({
      ok: false,
      reason: 'breaker',
    });
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS + 1);
  });

  it('[invariant] with the flag off every request still reaches the feed', async () => {
    flag.on = false;
    const fetchFeed = down();
    for (let i = 0; i < MIN_CALLS + 5; i++) await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed).toHaveBeenCalledTimes(MIN_CALLS + 5);
  });
});

describe('last-good page for anonymous first pages', () => {
  const prime = async (input: CapturableSearchInput = anon) =>
    serveFromFeed(input, {
      fetchFeed: async () => answer([9, 5], { nextCursor: '17|5', route: 'tag-walk' }),
      hydrate,
    });

  it('serves the last good page, hydrated again, when the feed fails', async () => {
    await prime();
    hydrate.mockClear();
    const r = await serveFromFeed(anon, { fetchFeed: down(), hydrate });
    expect(r.ok && r.page.data.map((d) => d.id)).toEqual([9, 5]);
    expect(r.ok && r.page.nextCursor).toBe('feed:17:5');
    expect(r.ok && r.page.stale).toBe(true);
    expect(hydrate).toHaveBeenCalledWith([9, 5]);
  });

  it('serves it on a 5xx and while the breaker is open, without calling the feed', async () => {
    await prime();
    const sick = vi.fn(async () => answer([], { status: 500 }));
    expect((await serveFromFeed(anon, { fetchFeed: sick, hydrate })).ok).toBe(true);
    // The priming success is the window's first call, so the 19th failure makes 20 calls.
    for (let i = 1; i < MIN_CALLS - 1; i++) await serveFromFeed(anon, { fetchFeed: sick, hydrate });
    expect(sick).toHaveBeenCalledTimes(MIN_CALLS - 1);
    const r = await serveFromFeed(anon, { fetchFeed: sick, hydrate });
    expect(r.ok && r.page.data.map((d) => d.id)).toEqual([9, 5]);
    expect(sick).toHaveBeenCalledTimes(MIN_CALLS - 1);
  });

  it('is gone after its TTL', async () => {
    await prime();
    vi.setSystemTime(Date.now() + TTL_MS + 1);
    expect(await serveFromFeed(anon, { fetchFeed: down(), hydrate })).toEqual({
      ok: false,
      reason: 'error',
    });
  });

  it('never answers a different filter set', async () => {
    await prime();
    for (const other of [
      { ...anon, browsingLevel: 1 },
      { ...anon, sort: 'Newest' },
      { ...anon, period: 'Day' },
    ])
      expect(await serveFromFeed(other, { fetchFeed: down(), hydrate })).toEqual({
        ok: false,
        reason: 'error',
      });
  });

  it('never answers a signed-in viewer, even with the same filters', async () => {
    await prime();
    hydrate.mockClear();
    const r = await serveFromFeed({ ...anon, currentUserId: 7 }, { fetchFeed: down(), hydrate });
    expect(r).toEqual({ ok: false, reason: 'error' });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("never stores a signed-in viewer's page", async () => {
    await prime({ ...anon, currentUserId: 7 });
    expect(
      await serveFromFeed({ ...anon, currentUserId: 7 }, { fetchFeed: down(), hydrate })
    ).toEqual({ ok: false, reason: 'error' });
    expect(await serveFromFeed(anon, { fetchFeed: down(), hydrate })).toEqual({
      ok: false,
      reason: 'error',
    });
  });

  it('never stores or serves a page past the first', async () => {
    const paged = { ...anon, cursor: 'feed:17:5' };
    await prime(paged);
    expect(await serveFromFeed(paged, { fetchFeed: down(), hydrate })).toEqual({
      ok: false,
      reason: 'error',
    });
  });

  it('a 4xx refusal is not answered from the cache', async () => {
    await prime();
    const r = await serveFromFeed(anon, {
      fetchFeed: async () => answer([], { status: 400 }),
      hydrate,
    });
    expect(r).toEqual({ ok: false, reason: 'status:400' });
  });

  it('[invariant] with the flag off a failure is not answered from a primed page', async () => {
    await prime();
    flag.on = false;
    // The flag is re-read at most every 5s.
    vi.setSystemTime(Date.now() + 5_001);
    const r = await serveFromFeed(anon, { fetchFeed: down(), hydrate });
    expect(r).toEqual({ ok: false, reason: 'error' });
  });
});

describe('last-good page: the REST route has its own bound', () => {
  const REST_MAX = 100;
  const ok = async () => answer([9, 5]);
  const restPage = (i: number) => ({ ...anon, userId: 1_000 + i });

  it('a burst of distinct REST first pages cannot evict a website page', async () => {
    await serveFromFeed(anon, { fetchFeed: ok, hydrate, route: 'website' });
    for (let i = 0; i < 600; i++)
      await serveFromFeed(restPage(i), { fetchFeed: ok, hydrate, route: 'rest' });
    const r = await serveFromFeed(anon, { fetchFeed: down(), hydrate, route: 'website' });
    expect(r.ok && r.page.stale).toBe(true);
  });

  it(`keeps at most ${REST_MAX} REST pages, dropping the oldest`, async () => {
    for (let i = 0; i <= REST_MAX; i++)
      await serveFromFeed(restPage(i), { fetchFeed: ok, hydrate, route: 'rest' });
    expect(await serveFromFeed(restPage(0), { fetchFeed: down(), hydrate, route: 'rest' })).toEqual(
      { ok: false, reason: 'error' }
    );
    const newest = await serveFromFeed(restPage(REST_MAX), {
      fetchFeed: down(),
      hydrate,
      route: 'rest',
    });
    expect(newest.ok && newest.page.stale).toBe(true);
  });
});
