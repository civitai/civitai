import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@civitai/auth';

const store = vi.hoisted(() => new Map<string, unknown>());
const flag = vi.hoisted(() => ({ variant: null as string | null }));
const invokeScan = vi.hoisted(() => vi.fn());

vi.mock('@civitai/redis', () => ({
  REDIS_SYS_KEYS: { TRAINING: { STUDIO_DATASET_RATING: 'rating' } },
}));
vi.mock('./redis', () => ({
  getSysRedis: () => ({
    packed: {
      mGet: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
      set: async (k: string, v: unknown) => void store.set(k, v),
    },
  }),
}));
vi.mock('./flipt', () => ({ flagVariant: async () => flag.variant }));
vi.mock('./axiom', () => ({ logToAxiom: async () => undefined, safeError: (e: unknown) => e }));
vi.mock('./orchestrator', () => ({ orchestratorClient: () => ({}) }));
// Hand-listed: the package's dist can't be loaded through importOriginal (see train-core.test.ts).
vi.mock('@civitai/orchestration-client', () => ({
  invokeImageScanningStepTemplate: (...args: unknown[]) => invokeScan(...args),
}));

const { datasetRatingFor, rateImage, runRatingJob } = await import('./dataset-rating');

const user = { id: 7 } as SessionUser;
const client = {} as Parameters<typeof rateImage>[0];
const ok = (label: string, restricted = false) => ({
  data: { nsfwLevel: 'na', ratingV2: { status: 'ok', sexual: { label }, restricted } },
  response: new Response(null, { status: 200 }),
});

beforeEach(() => {
  store.clear();
  flag.variant = null;
  invokeScan.mockReset();
});

describe('the flag', () => {
  it.each([null, '', 'on', 's9', 'level-2'])('variant %j leaves the v2 rating off', async (v) => {
    flag.variant = v;
    expect(await datasetRatingFor(user)).toBeUndefined();
  });

  it('a level variant turns it on, reading only well-formed cache entries', async () => {
    flag.variant = 'S3';
    store.set('rating:good', { s: 1, r: false });
    store.set('rating:junk', { s: 'x', r: false });
    const rating = (await datasetRatingFor(user))!;
    expect(rating.matureLevel).toBe(3);
    const read = await rating.read(['good', 'junk', 'missing']);
    expect([...read.keys()]).toEqual(['good']);
  });
});

describe('one rating call', () => {
  it('asks for the v2 rater and returns its rating', async () => {
    invokeScan.mockResolvedValueOnce(ok('S2', true));
    expect(await rateImage(client, 'blob-1', new AbortController().signal)).toEqual({
      rating: { s: 2, r: true },
    });
    expect(invokeScan.mock.calls[0]![0].body).toEqual({
      image: 'blob-1',
      'rater-model': 'radio-alpha',
    });
  });

  it.each([
    [
      'a status other than OK',
      { ratingV2: { status: 'error', sexual: { label: 'S0' }, restricted: false } },
    ],
    ['no ratingV2 block', { nsfwLevel: 'pg' }],
    [
      'an unknown label',
      { ratingV2: { status: 'ok', sexual: { label: 'S7' }, restricted: false } },
    ],
    ['no restricted flag', { ratingV2: { status: 'ok', sexual: { label: 'S0' } } }],
  ])('%s is no rating', async (_name, data) => {
    invokeScan.mockResolvedValueOnce({ data, response: new Response(null, { status: 200 }) });
    expect((await rateImage(client, 'b', new AbortController().signal)).rating).toBeNull();
  });

  it('a 429 is no rating, carrying Retry-After', async () => {
    invokeScan.mockResolvedValueOnce({
      data: undefined,
      response: new Response(null, { status: 429, headers: { 'retry-after': '3' } }),
    });
    expect(await rateImage(client, 'b', new AbortController().signal)).toEqual({
      rating: null,
      limited: true,
      retryAfterMs: 3000,
    });
  });

  it('a thrown call is no rating', async () => {
    invokeScan.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await rateImage(client, 'b', new AbortController().signal)).rating).toBeNull();
  });
});

describe('the rating job', () => {
  it('stores each OK rating and leaves the rest unrated', async () => {
    const rate = vi.fn(async (_c: unknown, key: string) =>
      key === 'bad' ? { rating: null } : { rating: { s: 1, r: false } }
    );
    const summary = await runRatingJob(client, ['a', 'bad', 'c'], rate);
    expect(summary).toMatchObject({
      images: 3,
      calls: 3,
      rated: 2,
      fallbacks: 1,
      deadlineHit: false,
    });
    expect(store.get('rating:a')).toEqual({ s: 1, r: false });
    expect(store.has('rating:bad')).toBe(false);
  });

  it('stops at the deadline, leaving unreached images unrated', async () => {
    // Each call hangs until the job's deadline aborts it.
    const rate = vi.fn(
      (_c: unknown, _k: string, signal: AbortSignal) =>
        new Promise<{ rating: null }>((resolve) =>
          signal.addEventListener('abort', () => resolve({ rating: null }))
        )
    );
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const summary = await runRatingJob(client, keys, rate, 30);
    expect(summary.deadlineHit).toBe(true);
    expect(summary.calls).toBeLessThan(5);
    expect(summary.rated).toBe(0);
    expect(store.size).toBe(0);
  });

  it('pauses on a 429 instead of hammering the rater', async () => {
    const rate = vi.fn(async () => ({ rating: null, limited: true, retryAfterMs: 10_000 }));
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const summary = await runRatingJob(client, keys, rate, 50);
    // Both workers' first calls, then the pause outlasts the deadline.
    expect(rate.mock.calls.length).toBeLessThanOrEqual(2);
    expect(summary).toMatchObject({ rateLimited: rate.mock.calls.length, deadlineHit: true });
  });
});
