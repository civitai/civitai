import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RatingService from '~/server/services/training-studio-dataset-rating.service';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

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
const limiter = vi.hoisted(() => ({ claim: vi.fn(), record: vi.fn(async () => undefined) }));
vi.mock('~/server/utils/rate-limit-bucket', () => ({ claimRateLimitAttempt: limiter.claim }));
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
import { STUDIO_DATASET_RATING_BATCH } from '~/server/schema/training-studio-dataset-rating.schema';

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
  });

  it('rates for the session user, counting the image against its per-minute and daily limits', async () => {
    const res = await call({ items: [item(1)] });
    expect(res.statusCode).toBe(200);
    expect(service.rate).toHaveBeenCalledWith({ items: [item(1)], userId: 7 });
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
    const res = await call({ items: [item(1)] });
    expect(res.statusCode).toBe(429);
    expect(service.rate).not.toHaveBeenCalled();
  });

  it('over the all-users daily cap: 429 with 0 submits, counted fail-closed', async () => {
    globalCap.check.mockResolvedValue({ allowed: false, retryAfterSeconds: 3600 });
    const res = await call({ items: [item(1)] });
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
      const res = await call({ items: [item(1)] });
      expect(res.statusCode).toBe(403);
      expect(service.rate).not.toHaveBeenCalled();
      expect(limiter.claim).not.toHaveBeenCalled();
      expect(globalCap.check).not.toHaveBeenCalled();
    }
  );

  it('a Flipt failure refuses', async () => {
    flag.variant.mockRejectedValue(new Error('flipt down'));
    expect((await call({ items: [item(1)] })).statusCode).toBe(403);
    expect(service.rate).not.toHaveBeenCalled();
  });

  it('reads the rating flag for this user, and a mature-level variant proceeds', async () => {
    flag.variant.mockResolvedValue('S3');
    expect((await call({ items: [item(1)] })).statusCode).toBe(200);
    expect(service.rate).toHaveBeenCalledTimes(1);
    expect(flag.variant.mock.calls[0]!.slice(0, 2)).toEqual(['trainingStudioDatasetRatingV2', '7']);
  });

  it('a user the Studio gate refuses rates nothing', async () => {
    gate.allow.mockResolvedValue(false);
    await call({ items: [item(1)] });
    expect(service.rate).not.toHaveBeenCalled();
  });

  it('refuses a batch over the cap with 0 submits', async () => {
    const items = Array.from({ length: STUDIO_DATASET_RATING_BATCH + 1 }, (_, i) => item(i));
    const res = await call({ items });
    expect(res.statusCode).toBe(400);
    expect(service.rate).not.toHaveBeenCalled();
  });
});
