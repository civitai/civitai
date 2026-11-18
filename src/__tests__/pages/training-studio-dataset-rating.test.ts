import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RatingService from '~/server/services/training-studio-dataset-rating.service';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as RateLimitBucket from '~/server/utils/rate-limit-bucket';

/** The Studio's dataset-rating endpoint runs free GPU work: it must sit behind the Studio gate and
 *  its rate limits, and refuse an oversized batch, before anything is submitted. */

const service = vi.hoisted(() => ({
  rate: vi.fn<(input: unknown) => Promise<{ results: never[] }>>(async () => ({ results: [] })),
}));
vi.mock('~/server/services/training-studio-dataset-rating.service', async (importOriginal) => {
  const actual = await importOriginal<typeof RatingService>();
  return {
    STUDIO_DATASET_RATING_RATE_LIMIT: actual.STUDIO_DATASET_RATING_RATE_LIMIT,
    STUDIO_DATASET_RATING_GLOBAL_LIMIT: actual.STUDIO_DATASET_RATING_GLOBAL_LIMIT,
    rateStudioDatasetImages: service.rate,
  };
});
const limiter = vi.hoisted(() => ({
  claim: vi.fn(),
  record: vi.fn(async () => undefined),
  peek: vi.fn(),
}));
vi.mock('~/server/utils/rate-limit-bucket', () => ({
  claimRateLimitAttempt: limiter.claim,
  peekRateLimit: limiter.peek,
}));
const usageRules = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('~/server/services/usage-limit-config.service', () => ({
  resolveUsageLimitRules: usageRules.resolve,
}));
const globalCap = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('~/server/utils/public-api-rate-limit', () => ({ checkFixedWindow: globalCap.check }));
const flag = vi.hoisted(() => ({ variant: vi.fn() }));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { TRAINING_STUDIO_DATASET_RATING_V2: 'trainingStudioDatasetRatingV2' },
  getFliptVariant: flag.variant,
}));
const gate = vi.hoisted(() => ({ allow: vi.fn() }));
vi.mock('~/server/utils/training-studio-access', () => ({ allowTrainingStudio: gate.allow }));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  handleEndpointError: (await importOriginal<typeof EndpointHelpers>()).handleEndpointError,
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: { id: number }) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { id: 7 }),
}));

import handler from '~/pages/api/training-studio/dataset-rating';
import { usageLimitDefsById } from '~/shared/constants/usage-limits';
import { throwRateLimited } from '~/server/utils/rate-limit-error';
import { STUDIO_DATASET_RATING_BATCH } from '~/server/schema/training-studio-dataset-rating.schema';

const body = (items: unknown[], matureLevel = 2) => ({ items, matureLevel });
const item = (i: number) => ({
  mediaUrl: `https://orchestration.civitai.com/v2/consumer/blobs/${i}.png`,
  key: `${i}.png`,
});

async function call(body: unknown) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  await (handler as unknown as (req: unknown, r: typeof res) => Promise<unknown>)(
    { method: 'POST', query: {}, body },
    res
  );
  return res;
}

describe('POST /api/training-studio/dataset-rating', () => {
  beforeEach(() => {
    service.rate.mockClear();
    gate.allow.mockReset().mockResolvedValue(true);
    flag.variant.mockReset().mockResolvedValue('s2');
    limiter.record.mockClear();
    limiter.claim.mockReset().mockResolvedValue(limiter.record);
    globalCap.check.mockReset().mockResolvedValue({ allowed: true });
    loggingMock.logToAxiom.mockReset();
    usageRules.resolve.mockReset().mockResolvedValue([{ id: 'dataset-rating.daily' }]);
    limiter.peek.mockReset().mockResolvedValue([{ used: 1000 }]);
  });

  it('rates for the session user, counting the image against its per-minute and daily limits', async () => {
    const res = await call(body([item(1)]));
    expect(res.statusCode).toBe(200);
    expect(service.rate).toHaveBeenCalledWith({ items: [item(1)], userId: 7, matureLevel: 2 });
  });

  it('a request for another level than the flag gives this user is refused before anything is counted', async () => {
    const res = await call(body([item(1)], 3));
    expect(res.statusCode).toBe(409);
    expect(limiter.claim).not.toHaveBeenCalled();
    expect(service.rate).not.toHaveBeenCalled();
  });

  it('the level the flag gives proceeds', async () => {
    flag.variant.mockResolvedValue('s3');
    expect((await call(body([item(1)], 3))).statusCode).toBe(200);
    expect(service.rate).toHaveBeenCalledWith({ items: [item(1)], userId: 7, matureLevel: 3 });
    expect(limiter.claim.mock.calls[0][0]).toMatchObject({
      keyName: 'training:studioDatasetRating',
      rules: { usageLimitIds: ['dataset-rating.submit', 'dataset-rating.daily'] },
    });
    expect(limiter.record).toHaveBeenCalled();
  });

  it('over a limit: 429 with 0 submits', async () => {
    limiter.claim.mockRejectedValue(
      new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' })
    );
    const res = await call(body([item(1)]));
    expect(res.statusCode).toBe(429);
    expect(service.rate).not.toHaveBeenCalled();
  });

  it('over the all-users daily cap: 429 with 0 submits, counted fail-closed', async () => {
    globalCap.check.mockResolvedValue({ allowed: false, retryAfterSeconds: 3600 });
    const res = await call(body([item(1)]));
    expect(res.statusCode).toBe(429);
    expect(service.rate).not.toHaveBeenCalled();
    expect(globalCap.check).toHaveBeenCalledWith(
      'training-studio:dataset-rating:global',
      50_000,
      86_400,
      { failOpen: false }
    );
  });

  it.each([
    ['off or matching no rule', null],
    ['an unknown variant', 'control'],
    ['the level that would count everything', 's0'],
  ])(
    'with the rating flag %s: 403 before any limit is counted or anything is submitted',
    async (_name, variant) => {
      flag.variant.mockResolvedValue(variant);
      const res = await call(body([item(1)]));
      expect(res.statusCode).toBe(403);
      expect(service.rate).not.toHaveBeenCalled();
      expect(limiter.claim).not.toHaveBeenCalled();
      expect(globalCap.check).not.toHaveBeenCalled();
    }
  );

  it('a Flipt failure refuses', async () => {
    flag.variant.mockRejectedValue(new Error('flipt down'));
    expect((await call(body([item(1)]))).statusCode).toBe(403);
    expect(service.rate).not.toHaveBeenCalled();
  });

  it('reads the rating flag for this user, and a mature-level variant proceeds', async () => {
    flag.variant.mockResolvedValue('S3');
    expect((await call(body([item(1)], 3))).statusCode).toBe(200);
    expect(service.rate).toHaveBeenCalledTimes(1);
    expect(flag.variant.mock.calls[0]!.slice(0, 2)).toEqual(['trainingStudioDatasetRatingV2', '7']);
  });

  it('a user the Studio gate refuses rates nothing', async () => {
    gate.allow.mockResolvedValue(false);
    await call(body([item(1)]));
    expect(service.rate).not.toHaveBeenCalled();
  });

  it('refuses a batch over the cap with 0 submits', async () => {
    const items = Array.from({ length: STUDIO_DATASET_RATING_BATCH + 1 }, (_, i) => item(i));
    const res = await call(body(items));
    expect(res.statusCode).toBe(400);
    expect(service.rate).not.toHaveBeenCalled();
  });
  it('caps each user at 60 images a minute and 1,000 a day', () => {
    const minute = usageLimitDefsById.get('dataset-rating.submit')!;
    const day = usageLimitDefsById.get('dataset-rating.daily')!;
    expect([minute.base, minute.window]).toEqual([60, { type: 'rolling', seconds: 60 }]);
    expect([day.base, day.window]).toEqual([1000, { type: 'rolling', seconds: 86_400 }]);
  });

  it('the per-user limit fails closed on a Redis error: its bucket is a fail-closed scope', async () => {
    const actual = await vi.importActual<typeof RateLimitBucket>(
      '~/server/utils/rate-limit-bucket'
    );
    expect(actual.isFailClosedRateLimitScope('training:studioDatasetRating')).toBe(true);
    limiter.claim.mockRejectedValue(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'temporarily unavailable' })
    );
    const res = await call(body([item(1)]));
    expect(res.statusCode).toBe(503);
    expect(service.rate).not.toHaveBeenCalled();
  });

  describe('a user reaching the daily cap', () => {
    const dailyRefusal = () =>
      limiter.claim.mockImplementation(async () =>
        throwRateLimited(
          { retryAfterSeconds: 60, retryAt: new Date().toISOString(), id: 'dataset-rating.daily' },
          'daily'
        )
      );
    // A fixed window per key, as checkFixedWindow counts it; with Redis down it answers by failOpen.
    const windows = (redisDown = false) => {
      const counts = new Map<string, number>();
      globalCap.check.mockImplementation(
        async (key: string, max: number, _window: number, opts?: { failOpen?: boolean }) => {
          if (redisDown) return { allowed: opts?.failOpen !== false, retryAfterSeconds: 1 };
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return { allowed: counts.get(key)! <= max, retryAfterSeconds: 1 };
        }
      );
    };

    it('logs nothing when the once-a-day check cannot reach Redis', async () => {
      windows(true);
      dailyRefusal();
      expect((await call(body([item(1)]))).statusCode).toBe(429);
      expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
    });

    it('still logs, with no count, when the count cannot be read', async () => {
      windows();
      dailyRefusal();
      limiter.peek.mockRejectedValue(new Error('cache down'));
      expect((await call(body([item(1)]))).statusCode).toBe(429);
      expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
      expect(loggingMock.logToAxiom.mock.calls[0]![0]).toMatchObject({
        userId: 7,
        payload: { count: null },
      });
    });

    it('logs the user id and count to Axiom once, with no blob ids', async () => {
      windows();
      dailyRefusal();
      expect((await call(body([item(1)]))).statusCode).toBe(429);
      expect((await call(body([item(2)]))).statusCode).toBe(429);
      expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
      const [entry] = loggingMock.logToAxiom.mock.calls[0]!;
      expect(entry).toMatchObject({
        name: 'training-studio-dataset-rating-daily-cap',
        userId: 7,
        payload: { count: 1000 },
      });
      expect(JSON.stringify(entry)).not.toMatch(/\.png|blobs/);
      expect(service.rate).not.toHaveBeenCalled();
    });

    it('a per-minute refusal is not the abuse signal', async () => {
      windows();
      limiter.claim.mockImplementation(async () =>
        throwRateLimited(
          { retryAfterSeconds: 5, retryAt: new Date().toISOString(), id: 'dataset-rating.submit' },
          'minute'
        )
      );
      expect((await call(body([item(1)]))).statusCode).toBe(429);
      expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
    });
  });
});
