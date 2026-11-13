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

const flag = vi.hoisted(() => ({ on: true, widen: null as boolean | null }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFliptSync: (key: string) =>
      key === 'feed-service-degrade'
        ? flag.on
        : key === 'feed-service-timeout-widen'
        ? flag.widen
        : actual.isFliptSync(key as never),
  };
});

const THRESHOLD = 10;
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
  flag.widen = null;
  // Fresh breaker, cache and flag gate per test.
  delete (globalThis as { __civitaiFeedDegradeState?: unknown }).__civitaiFeedDegradeState;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
  hydrate.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('feed-service request timeout', () => {
  it('asks the feed with a 2.5s budget', async () => {
    expect(FEED_PRIMARY_TIMEOUT_MS).toBe(2_500);
    const fetchFeed = vi.fn<FeedPrimaryDeps<{ id: number }>['fetchFeed']>(async () => answer([1]));
    await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed.mock.calls[0]?.[1]).toBe(2_500);
  });

  it('goes back to 5s when feed-service-timeout-widen is on, and stays 2.5s when it is off', async () => {
    const fetchFeed = vi.fn<FeedPrimaryDeps<{ id: number }>['fetchFeed']>(async () => answer([1]));
    flag.widen = true;
    await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed.mock.calls[0]?.[1]).toBe(5_000);

    flag.widen = false;
    // The switch is re-read at most every 5s.
    vi.setSystemTime(Date.now() + 5_001);
    await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed.mock.calls[1]?.[1]).toBe(2_500);
  });
});

describe('feed-service circuit breaker', () => {
  it(`opens after ${THRESHOLD} failures and stops calling the feed`, async () => {
    const fetchFeed = down();
    for (let i = 0; i < THRESHOLD; i++)
      expect(await serveFromFeed(anon, { fetchFeed, hydrate })).toEqual({
        ok: false,
        reason: 'error',
      });
    expect(fetchFeed).toHaveBeenCalledTimes(THRESHOLD);

    const started = performance.now();
    const r = await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(performance.now() - started).toBeLessThan(50);
    expect(r).toEqual({ ok: false, reason: 'breaker' });
    expect(fetchFeed).toHaveBeenCalledTimes(THRESHOLD);
  });

  it('counts 5xx answers and not 4xx ones', async () => {
    const refused = vi.fn(async () => answer([], { status: 400 }));
    for (let i = 0; i < THRESHOLD + 2; i++)
      await serveFromFeed(anon, { fetchFeed: refused, hydrate });
    expect(refused).toHaveBeenCalledTimes(THRESHOLD + 2);

    const sick = vi.fn(async () => answer([], { status: 503 }));
    for (let i = 0; i < THRESHOLD; i++) await serveFromFeed(anon, { fetchFeed: sick, hydrate });
    expect(await serveFromFeed(anon, { fetchFeed: sick, hydrate })).toEqual({
      ok: false,
      reason: 'breaker',
    });
    expect(sick).toHaveBeenCalledTimes(THRESHOLD);
  });

  it('does not open on failures spread wider than the window', async () => {
    const fetchFeed = down();
    for (let i = 0; i < THRESHOLD * 2; i++) {
      await serveFromFeed(anon, { fetchFeed, hydrate });
      vi.setSystemTime(Date.now() + 3_500);
    }
    expect(fetchFeed).toHaveBeenCalledTimes(THRESHOLD * 2);
  });

  it('half-opens after the cooldown: one trial, closing on success', async () => {
    const fetchFeed = down();
    for (let i = 0; i < THRESHOLD; i++) await serveFromFeed(anon, { fetchFeed, hydrate });
    vi.setSystemTime(Date.now() + COOLDOWN_MS - 1);
    await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed).toHaveBeenCalledTimes(THRESHOLD);

    vi.setSystemTime(Date.now() + 1);
    fetchFeed.mockResolvedValue(answer([4]));
    expect((await serveFromFeed(anon, { fetchFeed, hydrate })).ok).toBe(true);
    expect((await serveFromFeed(anon, { fetchFeed, hydrate })).ok).toBe(true);
    expect(fetchFeed).toHaveBeenCalledTimes(THRESHOLD + 2);
  });

  it('lets one trial through at a time, and re-opens when it fails', async () => {
    const fetchFeed = down();
    for (let i = 0; i < THRESHOLD; i++) await serveFromFeed(anon, { fetchFeed, hydrate });
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
    expect(fetchFeed).toHaveBeenCalledTimes(THRESHOLD + 1);

    // Re-opened: a fresh cooldown before the next trial.
    vi.setSystemTime(Date.now() + COOLDOWN_MS - 1);
    expect(await serveFromFeed(anon, { fetchFeed, hydrate })).toEqual({
      ok: false,
      reason: 'breaker',
    });
    expect(fetchFeed).toHaveBeenCalledTimes(THRESHOLD + 1);
  });

  it('[invariant] with the flag off every request still reaches the feed', async () => {
    flag.on = false;
    const fetchFeed = down();
    for (let i = 0; i < THRESHOLD + 5; i++) await serveFromFeed(anon, { fetchFeed, hydrate });
    expect(fetchFeed).toHaveBeenCalledTimes(THRESHOLD + 5);
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
    for (let i = 1; i < THRESHOLD; i++) await serveFromFeed(anon, { fetchFeed: sick, hydrate });
    expect(sick).toHaveBeenCalledTimes(THRESHOLD);
    const r = await serveFromFeed(anon, { fetchFeed: sick, hydrate });
    expect(r.ok && r.page.data.map((d) => d.id)).toEqual([9, 5]);
    expect(sick).toHaveBeenCalledTimes(THRESHOLD);
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
