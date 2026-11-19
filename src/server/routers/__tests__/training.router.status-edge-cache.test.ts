import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

/**
 * `training.getStatus` and `training.getPublicStatus` are edge-cached. A cold pod that cannot read
 * the training status answers a fail-closed "temporarily unavailable" (paused) fallback; that
 * answer must not be cached at the edge, where it would be served to everyone for the TTL after
 * the pod recovers. Same rule as `generation.getStatus`.
 *
 * The REAL `getTrainingServiceStatusState` runs here — only sysRedis is driven — so this pins the
 * seam (the service's `known` reaching the router's `ctx.cache.skip`), not either side alone.
 */

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ imageTraining: true }),
}));

import { trainingRouter } from '~/server/routers/training.router';
import {
  __resetTrainingStatusLastKnownForTests,
  TRAINING_STATUS_UNKNOWN_MESSAGE,
} from '~/server/services/training.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const hGet = redisMock.sysRedis.hGet;

function call(proc: 'getStatus' | 'getPublicStatus') {
  const cache: { edgeTTL: number; skip?: boolean } = { edgeTTL: 0 };
  const caller = trainingRouter.createCaller({
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache,
    features: { trpcFlagGuardPerRequest: true, imageTraining: true },
    track: undefined,
  } as never);
  return { cache, result: caller[proc]() };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  __resetTrainingStatusLastKnownForTests();
  redisMock.withSysReadDeadline.mockImplementation((p) => p);
  hGet.mockResolvedValue(JSON.stringify({ available: true }));
});

describe.each(['getStatus', 'getPublicStatus'] as const)('training.%s edge caching', (proc) => {
  it('does NOT edge-cache the fail-closed fallback served while the status is unknown', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const { cache, result } = call(proc);

    expect((await result).available).toBe(false);
    expect(cache.skip).toBe(true);
  });

  it('edge-caches a status that was actually read (an operator pause included)', async () => {
    hGet.mockResolvedValue(JSON.stringify({ available: false, message: 'maintenance' }));

    const { cache, result } = call(proc);

    expect((await result).available).toBe(false);
    expect(cache.skip).toBeUndefined();
  });

  it('edge-caches the last-known value served through an outage', async () => {
    hGet.mockResolvedValueOnce(JSON.stringify({ available: false, message: 'maintenance' }));
    await call(proc).result;
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const { cache, result } = call(proc);

    expect((await result).available).toBe(false);
    expect(cache.skip).toBeUndefined();
  });

  it('TRAINING_STATUS_FAIL_CLOSED off: the "available" default is cached, as before', async () => {
    setEnv({ TRAINING_STATUS_FAIL_CLOSED: false });
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const { cache, result } = call(proc);

    expect((await result).available).toBe(true);
    expect(cache.skip).toBeUndefined();
  });
});

describe('training.getPublicStatus response shape', () => {
  it('is still `{ available }` only, the fallback included', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));
    await expect(call('getPublicStatus').result).resolves.toStrictEqual({ available: false });
  });

  it('getStatus carries the fallback message', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));
    await expect(call('getStatus').result).resolves.toMatchObject({
      available: false,
      message: TRAINING_STATUS_UNKNOWN_MESSAGE,
    });
  });
});
