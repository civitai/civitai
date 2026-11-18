import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@civitai/auth';

const store = vi.hoisted(() => new Map<string, unknown>());
const redisDown = vi.hoisted(() => ({ value: false }));
const flag = vi.hoisted(() => ({ variant: null as string | null }));
const invokeScan = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => vi.fn());

vi.mock('@civitai/redis', () => ({
  REDIS_SYS_KEYS: {
    TRAINING: {
      STUDIO_DATASET_RATING: 'rating',
      STUDIO_DATASET_RATING_DAILY: 'daily',
      STUDIO_DATASET_RATING_SENT: 'sent',
    },
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
    set: async (k: string, v: unknown, opts?: { NX?: boolean }) => {
      if (opts?.NX && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => Number(store.delete(k)),
    mGet: async (keys: string[]) => keys.map((k) => (store.get(k) as string | undefined) ?? null),
  }),
}));
const flagVariant = vi.hoisted(() => vi.fn(async () => flag.variant));
vi.mock('./flipt', () => ({ flagVariant }));
vi.mock('./axiom', () => ({ logToAxiom: async () => undefined, safeError: (e: unknown) => e }));
vi.mock('./orchestrator', () => ({ orchestratorClient: () => ({}) }));
// Hand-listed: the package's dist can't be loaded through importOriginal (see train-core.test.ts).
vi.mock('@civitai/orchestration-client', () => ({
  invokeImageScanningStepTemplate: (...args: unknown[]) => invokeScan(...args),
  refreshBlob: (...args: unknown[]) => refresh(...args),
}));
vi.mock('./main-app', () => ({ mainAppSessionOrigin: () => 'https://civitai.test' }));
// The main app's rating endpoint: `scan` answers each request's one item with its mature verdict, or
// a whole Response (a refusal).
const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
  const { items } = JSON.parse(String(init.body)) as { items: { key: string; mediaUrl: string }[] };
  const answer: unknown = await scan(items[0]);
  return answer instanceof Response
    ? answer
    : Response.json({ results: [{ key: items[0]!.key, mature: answer }] });
});
vi.stubGlobal('fetch', fetchMock);

const {
  claimDaily,
  DATASET_RATING_DAILY_CALLS,
  datasetRatingFor,
  rateImage,
  runRatingJob,
  warmDatasetRating,
} = await import('./dataset-rating');

const user = { id: 7 } as SessionUser;
const client = { client: {}, cookie: 'session=1', matureLevel: 1 } as Parameters<
  typeof rateImage
>[0];
const signedUrl = (id: string) => `https://orchestration.civitai.com/v2/consumer/blobs/${id}?sig=x`;
const refused = (status: number, retryAfter?: string) =>
  new Response(null, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

beforeEach(() => {
  store.clear();
  redisDown.value = false;
  flag.variant = null;
  invokeScan.mockReset();
  refresh.mockReset().mockImplementation(async ({ path }: { path: { blobId: string } }) => ({
    data: { url: signedUrl(path.blobId) },
  }));
  scan.mockReset();
  fetchMock.mockClear();
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
      store.set(`rating:radio-alpha:m${level}:good`, { mature: false });
      store.set(`rating:radio-alpha:m${level}:junk`, { mature: 'x' });
      // A verdict made at another level is not this level's verdict.
      store.set(`rating:radio-alpha:m${(level % 4) + 1}:other`, { mature: true });
      const rating = (await datasetRatingFor(user))!;
      expect(rating.matureLevel).toBe(level);
      // The Flipt flag key is the contract with flag state.
      expect(flagVariant).toHaveBeenCalledWith('trainingStudioDatasetRatingV2', user);
      const read = await rating.read(['good', 'junk', 'other', 'missing']);
      expect([...read.keys()]).toEqual(['good']);
    }
  );
});

describe('one rating call', () => {
  it("scans the URL the user's token minted on the main app's free path, never with the user's token", async () => {
    scan.mockResolvedValueOnce(true);
    const { signal } = new AbortController();
    expect(await rateImage(client, 'blob-1.png', signal)).toEqual({ rating: { mature: true } });
    expect(refresh.mock.calls[0]![0]).toMatchObject({
      client: client.client,
      path: { blobId: 'blob-1.png' },
      signal,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://civitai.test/api/training-studio/dataset-rating');
    expect(init.headers).toMatchObject({ cookie: 'session=1' });
    expect(JSON.parse(String(init.body))).toEqual({
      items: [{ key: 'blob-1.png', mediaUrl: signedUrl('blob-1.png') }],
      matureLevel: 1,
    });
    // A scan submitted with the user's own token is charged to them.
    expect(invokeScan).not.toHaveBeenCalled();
  });

  it.each([
    ['no verdict (null)', null],
    ['a verdict that is not a boolean', 'true'],
    ['a level instead of a verdict', 3],
  ])('%s is no rating', async (_name, verdict) => {
    scan.mockResolvedValueOnce(verdict);
    expect((await rateImage(client, 'b.png', new AbortController().signal)).rating).toBeNull();
  });

  it.each(['x@other', 'urn:air:x', 'a/b', 'a b', ''])(
    'an id that is not a plain blob key (%j) is never sent',
    async (id) => {
      expect((await rateImage(client, id, new AbortController().signal)).rating).toBeNull();
      expect(refresh).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("a blob the user's token can't refresh is never sent to the main app", async () => {
    refresh.mockResolvedValueOnce({ data: undefined, error: { status: 404 } });
    expect(await rateImage(client, 'b.png', new AbortController().signal)).toEqual({
      rating: null,
      notSent: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the main app's 429 is no rating, carrying Retry-After", async () => {
    scan.mockResolvedValueOnce(refused(429, '3'));
    expect(await rateImage(client, 'b.png', new AbortController().signal)).toEqual({
      rating: null,
      limited: true,
      retryAfterMs: 3000,
      notSent: true,
    });
  });

  it("the main app's 429 without Retry-After pauses past the job's deadline", async () => {
    scan.mockResolvedValueOnce(refused(429));
    expect(await rateImage(client, 'b.png', new AbortController().signal)).toMatchObject({
      limited: true,
      retryAfterMs: 60_000,
    });
  });

  it('an answer without the requested image is no rating, though it may have reached the rater', async () => {
    scan.mockResolvedValueOnce(Response.json({ results: [{ key: 'other.png', mature: false }] }));
    expect(await rateImage(client, 'b.png', new AbortController().signal)).toEqual({
      rating: null,
    });
  });

  it('an answer from a main app that predates the bit is refused, so the marker is released', async () => {
    scan.mockResolvedValueOnce(
      Response.json({ results: [{ key: 'b.png', output: { ratingV2: { status: 'ok' } } }] })
    );
    expect(await rateImage(client, 'b.png', new AbortController().signal)).toEqual({
      rating: null,
      notSent: true,
    });
  });

  it("the main app's refusal is no rating, and nothing reached the rater", async () => {
    scan.mockResolvedValueOnce(refused(400));
    expect(await rateImage(client, 'b.png', new AbortController().signal)).toEqual({
      rating: null,
      notSent: true,
    });
  });

  it('a 5xx may have reached the rater', async () => {
    scan.mockResolvedValueOnce(refused(502));
    expect(await rateImage(client, 'b.png', new AbortController().signal)).toEqual({
      rating: null,
    });
  });

  it('a presign that throws is no rating, and nothing reached the rater', async () => {
    refresh.mockRejectedValueOnce(new Error('aborted'));
    expect(await rateImage(client, 'b.png', new AbortController().signal)).toEqual({
      rating: null,
      notSent: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a thrown call is no rating', async () => {
    scan.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await rateImage(client, 'b.png', new AbortController().signal)).rating).toBeNull();
  });
});

describe('the rating job', () => {
  it('stores each OK rating and leaves the rest unrated', async () => {
    const rate = vi.fn(async (_c: unknown, key: string) =>
      key === 'bad.png' ? { rating: null } : { rating: { mature: false } }
    );
    const summary = await runRatingJob(client, ['a.png', 'bad.png', 'c.png'], rate);
    expect(summary).toMatchObject({
      images: 3,
      calls: 3,
      rated: 2,
      fallbacks: 1,
      deadlineHit: false,
    });
    expect(store.get('rating:radio-alpha:m1:a.png')).toEqual({ mature: false });
    expect(store.has('rating:radio-alpha:m1:bad.png')).toBe(false);
  });

  it('sends only images to the rater, counting the rest as skipped', async () => {
    const rate = vi.fn(async (_c: unknown, _key: string) => ({ rating: { mature: false } }));
    const summary = await runRatingJob(
      client,
      ['voice.wav', 'clip.mp4', 'Photo.JPG', 'noextension', 'pic.webp'],
      rate
    );
    expect(rate.mock.calls.map(([, key]) => key)).toEqual(['Photo.JPG', 'pic.webp']);
    expect(summary).toMatchObject({ images: 5, skipped: 3, calls: 2, rated: 2, fallbacks: 0 });
  });

  it('a blob sent once is not sent again by a later job, whatever came back', async () => {
    const rate = vi.fn(async () => ({ rating: null }));
    await runRatingJob(client, ['a.png', 'b.png'], rate);
    const again = await runRatingJob(client, ['a.png', 'b.png'], rate);
    expect(rate).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ calls: 0, alreadySent: 2, rated: 0 });
  });

  it('a blob nothing reached the rater with may be sent again', async () => {
    const rate = vi.fn(async () => ({ rating: null, notSent: true as const }));
    await runRatingJob(client, ['a.png'], rate);
    const again = await runRatingJob(client, ['a.png'], rate);
    expect(rate).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ calls: 1, alreadySent: 0 });
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
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}.png`);
    const summary = await runRatingJob(client, keys, rate, 30);
    expect(summary.deadlineHit).toBe(true);
    expect(summary.calls).toBeLessThan(5);
    expect(summary.rated).toBe(0);
    expect([...store.keys()].filter((k) => k.startsWith('rating:'))).toEqual([]);
  });

  it('pauses on a 429 instead of hammering the rater', async () => {
    const rate = vi.fn(async () => ({ rating: null, limited: true, retryAfterMs: 10_000 }));
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}.png`);
    const summary = await runRatingJob(client, keys, rate, 50);
    // Both workers' first calls, then the pause outlasts the deadline.
    expect(rate.mock.calls.length).toBeLessThanOrEqual(2);
    expect(summary).toMatchObject({ rateLimited: rate.mock.calls.length, deadlineHit: true });
  });
});

describe('starting a job', () => {
  it('starts nothing for a user whose job is still running', async () => {
    let release!: () => void;
    scan.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(false);
        })
    );
    warmDatasetRating('t', 9, 1, ['a.png'], 'c');
    warmDatasetRating('t', 9, 1, ['b.png'], 'c');
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    expect(scan.mock.calls[0]![0].key).toBe('a.png');
    release();
    await vi.waitFor(() =>
      expect(store.get('rating:radio-alpha:m1:a.png')).toEqual({ mature: false })
    );
  });

  it('a later view after a call that reached the rater and failed sends nothing again', async () => {
    scan.mockResolvedValue(refused(502));
    warmDatasetRating('t', 16, 1, ['a.png'], 'c');
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    expect(store.has('sent:radio-alpha:m1:a.png')).toBe(true);
    // Another user's view of the same blob, so this user's running job can't be what stops it.
    warmDatasetRating('t', 19, 1, ['a.png'], 'c');
    await new Promise((r) => setTimeout(r, 20));
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('an image already sent takes no allowance slot from one that was not', async () => {
    // One send left today, and the first image of the dataset was sent before.
    await claimDaily('calls', 21, DATASET_RATING_DAILY_CALLS - 1);
    store.set('sent:radio-alpha:m1:a.png', '1');
    scan.mockResolvedValue(false);
    warmDatasetRating('t', 21, 1, ['a.png', 'b.png'], 'c');
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    expect(scan.mock.calls[0]![0].key).toBe('b.png');
  });

  it('a view of an already-rated dataset, which has no unrated keys, makes 0 rate calls', async () => {
    warmDatasetRating('t', 17, 1, [], 'c');
    await new Promise((r) => setTimeout(r, 20));
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no session to call the main app with, rates nothing', async () => {
    warmDatasetRating('t', 18, 1, ['a.png'], null);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('claims allowance only for the images in a dataset', async () => {
    scan.mockResolvedValue(false);
    warmDatasetRating('t', 14, 1, ['a.wav', 'b.mp4', 'c.png'], 'c');
    await vi.waitFor(() =>
      expect(store.get('rating:radio-alpha:m1:c.png')).toEqual({ mature: false })
    );
    expect(scan).toHaveBeenCalledTimes(1);
    const day = new Date().toISOString().slice(0, 10);
    expect(store.get(`daily:calls:14:${day}`)).toBe(1);
  });

  it('a job over the allowance rates only what was granted', async () => {
    await claimDaily('calls', 11, DATASET_RATING_DAILY_CALLS - 1);
    scan.mockResolvedValue(false);
    warmDatasetRating('t', 11, 1, ['a.png', 'b.png', 'c.png'], 'c');
    await vi.waitFor(() =>
      expect(store.get('rating:radio-alpha:m1:a.png')).toEqual({ mature: false })
    );
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

it('gives back the allowance for images a job did not reach', async () => {
  // Every call is rate-limited past the deadline, so each worker makes one call and the rest go unreached.
  scan.mockImplementation(async () => refused(429, '60'));
  warmDatasetRating('t', 12, 1, ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'], 'c', 30);
  const day = new Date().toISOString().slice(0, 10);
  await vi.waitFor(() => expect(store.get(`daily:calls:12:${day}`)).toBe(2));
});

it('gives the allowance back to the day it was claimed on, across UTC midnight', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-11-12T23:59:59.900Z'));
    // The first call lands after midnight; every call is rate-limited past the deadline.
    scan.mockImplementation(async () => {
      await Promise.resolve(); // both workers have made their call by now
      vi.setSystemTime(new Date('2026-11-13T00:00:00.100Z'));
      return refused(429, '60');
    });
    warmDatasetRating('t', 13, 1, ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'], 'c', 30);
    await vi.waitFor(() => expect(store.get('daily:calls:13:2026-11-12')).toBe(2));
    expect(store.has('daily:calls:13:2026-11-13')).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
