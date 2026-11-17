import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@civitai/auth';

const store = vi.hoisted(() => new Map<string, unknown>());
const redisDown = vi.hoisted(() => ({ value: false }));
const flag = vi.hoisted(() => ({ variant: null as string | null }));
const invokeScan = vi.hoisted(() => vi.fn());

vi.mock('@civitai/redis', () => ({
  REDIS_SYS_KEYS: {
    TRAINING: { STUDIO_DATASET_RATING: 'rating', STUDIO_DATASET_RATING_DAILY: 'daily' },
  },
}));
vi.mock('./redis', () => ({
  getSysRedis: () => ({
    packed: {
      mGet: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
      set: async (k: string, v: unknown) => void store.set(k, v),
    },
    incrBy: async (k: string, n: number) => {
      if (redisDown.value) throw new Error('redis down');
      const v = ((store.get(k) as number) ?? 0) + n;
      store.set(k, v);
      return v;
    },
    decrBy: async (k: string, n: number) => {
      const v = ((store.get(k) as number) ?? 0) - n;
      store.set(k, v);
      return v;
    },
    expire: async () => true,
  }),
}));
const flagVariant = vi.hoisted(() => vi.fn(async () => flag.variant));
vi.mock('./flipt', () => ({ flagVariant }));
vi.mock('./axiom', () => ({ logToAxiom: async () => undefined, safeError: (e: unknown) => e }));
vi.mock('./orchestrator', () => ({ orchestratorClient: () => ({}) }));
// Hand-listed: the package's dist can't be loaded through importOriginal (see train-core.test.ts).
vi.mock('@civitai/orchestration-client', () => ({
  invokeImageScanningStepTemplate: (...args: unknown[]) => invokeScan(...args),
}));

const {
  claimDaily,
  DATASET_RATING_DAILY_CALLS,
  datasetRatingFor,
  rateImage,
  runRatingJob,
  warmDatasetRating,
} = await import('./dataset-rating');

const user = { id: 7 } as SessionUser;
const client = {} as Parameters<typeof rateImage>[0];
const ok = (label: string, restricted = false) => ({
  data: { nsfwLevel: 'na', ratingV2: { status: 'ok', sexual: { label }, restricted } },
  response: new Response(null, { status: 200 }),
});

beforeEach(() => {
  store.clear();
  redisDown.value = false;
  flag.variant = null;
  invokeScan.mockReset();
});

describe('the flag', () => {
  it.each([null, '', 'on', 's0', 's9', 'level-2'])(
    'variant %j leaves the v2 rating off',
    async (v) => {
      flag.variant = v;
      expect(await datasetRatingFor(user)).toBeUndefined();
    }
  );

  // Any level: the deployed one is flag state, not in the repo.
  it.each([1, 2, 3, 4])(
    'a level variant (%i) turns it on, reading only well-formed cache entries',
    async (level) => {
      flag.variant = `S${level}`;
      store.set('rating:radio-alpha:good', { s: 1, r: false });
      store.set('rating:radio-alpha:junk', { s: 'x', r: false });
      const rating = (await datasetRatingFor(user))!;
      expect(rating.matureLevel).toBe(level);
      // The Flipt flag key is the contract with flag state.
      expect(flagVariant).toHaveBeenCalledWith('trainingStudioDatasetRatingV2', user);
      const read = await rating.read(['good', 'junk', 'missing']);
      expect([...read.keys()]).toEqual(['good']);
    }
  );
});

describe('one rating call', () => {
  it('asks for the v2 rater and returns its rating', async () => {
    invokeScan.mockResolvedValueOnce(ok('S2', true));
    const { signal } = new AbortController();
    expect(await rateImage(client, 'blob-1', signal)).toEqual({
      rating: { s: 2, r: true },
    });
    // The job's deadline must reach the call, or it runs on past it.
    expect(invokeScan.mock.calls[0]![0].signal).toBe(signal);
    expect(invokeScan.mock.calls[0]![0].body).toEqual({
      // The exact form the recipe takes a blob in; a bare id is decoded as base64 and refused.
      image: 'urn:air:other:other:orchestrator:blob@blob-1',
      'rater-model': 'radio-alpha',
    });
  });

  it.each([
    [
      'a status in another case',
      { ratingV2: { status: 'OK', sexual: { label: 'S0' }, restricted: false } },
    ],
    [
      'an error status',
      { ratingV2: { status: 'error', sexual: { label: 'S0' }, restricted: false } },
    ],
    ['no ratingV2 block', { nsfwLevel: 'pg' }],
    ['only a top-level nsfwLevel', { nsfwLevel: 'xxx', ratingV2: null }],
    [
      'an unknown label',
      { ratingV2: { status: 'ok', sexual: { label: 'S7' }, restricted: false } },
    ],
    ['no restricted flag', { ratingV2: { status: 'ok', sexual: { label: 'S0' } } }],
  ])('%s is no rating', async (_name, data) => {
    invokeScan.mockResolvedValueOnce({ data, response: new Response(null, { status: 200 }) });
    expect((await rateImage(client, 'b', new AbortController().signal)).rating).toBeNull();
  });

  it.each(['x@other', 'urn:air:x', 'a/b', 'a b', ''])(
    'an id that is not a plain blob key (%j) is never sent',
    async (id) => {
      expect((await rateImage(client, id, new AbortController().signal)).rating).toBeNull();
      expect(invokeScan).not.toHaveBeenCalled();
    }
  );

  it.each(['abc.jpeg', 'def.webp', 'ghi'])('sends %j as a blob AIR, extension kept', async (id) => {
    invokeScan.mockResolvedValueOnce(ok('S0'));
    await rateImage(client, id, new AbortController().signal);
    expect(invokeScan.mock.calls[0]![0].body.image).toBe(
      `urn:air:other:other:orchestrator:blob@${id}`
    );
  });

  it('reads a label in either case', async () => {
    invokeScan.mockResolvedValueOnce(ok('s3'));
    expect((await rateImage(client, 'b', new AbortController().signal)).rating).toEqual({
      s: 3,
      r: false,
    });
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
    expect(store.get('rating:radio-alpha:a')).toEqual({ s: 1, r: false });
    expect(store.has('rating:radio-alpha:bad')).toBe(false);
  });

  it('stops at the deadline, leaving unreached images unrated', async () => {
    // Each call hangs until the job's deadline aborts it.
    const rate = vi.fn(
      (_c: unknown, _k: string, signal: AbortSignal) =>
        new Promise<{ rating: null }>((resolve) => {
          // Already past the deadline: answer at once, so a loop that ignores it fails on the count.
          if (signal.aborted) return resolve({ rating: null });
          signal.addEventListener('abort', () => resolve({ rating: null }));
        })
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

describe('starting a job', () => {
  it('starts nothing for a user whose job is still running', async () => {
    let release!: () => void;
    invokeScan.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok('S0'));
        })
    );
    warmDatasetRating('t', 9, ['a']);
    warmDatasetRating('t', 9, ['b']);
    await vi.waitFor(() => expect(invokeScan).toHaveBeenCalledTimes(1));
    expect(invokeScan.mock.calls[0]![0].body.image).toBe('urn:air:other:other:orchestrator:blob@a');
    release();
    await vi.waitFor(() => expect(store.get('rating:radio-alpha:a')).toEqual({ s: 0, r: false }));
  });
});

describe('the daily allowance', () => {
  it('grants up to the cap across calls, then none', async () => {
    expect(await claimDaily('calls', 3, DATASET_RATING_DAILY_CALLS - 10)).toBe(
      DATASET_RATING_DAILY_CALLS - 10
    );
    expect(await claimDaily('calls', 3, 25)).toBe(10);
    expect(await claimDaily('calls', 3, 1)).toBe(0);
    // Another user's allowance is their own.
    expect(await claimDaily('calls', 4, 5)).toBe(5);
  });

  it('grants nothing when Redis is down', async () => {
    redisDown.value = true;
    expect(await claimDaily('lookups', 3, 1)).toBe(0);
  });

  it('a job over the allowance rates only what was granted', async () => {
    await claimDaily('calls', 11, DATASET_RATING_DAILY_CALLS - 1);
    invokeScan.mockResolvedValue(ok('S0'));
    warmDatasetRating('t', 11, ['a', 'b', 'c']);
    await vi.waitFor(() => expect(store.get('rating:radio-alpha:a')).toEqual({ s: 0, r: false }));
    expect(invokeScan).toHaveBeenCalledTimes(1);
  });
});

it('gives back the allowance for images a job did not reach', async () => {
  // Every call is rate-limited past the deadline, so each worker makes one call and the rest go unreached.
  invokeScan.mockResolvedValue({
    data: undefined,
    response: new Response(null, { status: 429, headers: { 'retry-after': '60' } }),
  });
  warmDatasetRating('t', 12, ['a', 'b', 'c', 'd', 'e', 'f'], 30);
  const day = new Date().toISOString().slice(0, 10);
  await vi.waitFor(() => expect(store.get(`daily:calls:12:${day}`)).toBe(2));
});

it('gives the allowance back to the day it was claimed on, across UTC midnight', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-11-12T23:59:59.900Z'));
    // The first call lands after midnight; every call is rate-limited past the deadline.
    invokeScan.mockImplementation(async () => {
      await Promise.resolve(); // both workers have made their call by now
      vi.setSystemTime(new Date('2026-11-13T00:00:00.100Z'));
      return {
        data: undefined,
        response: new Response(null, { status: 429, headers: { 'retry-after': '60' } }),
      };
    });
    warmDatasetRating('t', 13, ['a', 'b', 'c', 'd', 'e', 'f'], 30);
    await vi.waitFor(() => expect(store.get('daily:calls:13:2026-11-12')).toBe(2));
    expect(store.has('daily:calls:13:2026-11-13')).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
