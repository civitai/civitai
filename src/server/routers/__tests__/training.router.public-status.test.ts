import type { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as TrainingService from '~/server/services/training.service';

/**
 * `training.getPublicStatus` tells anyone, signed in or not, whether training is on — and nothing
 * else. `training.getStatus` keeps its imageTraining flag guard: it also returns the operator
 * message and the blocked-model list.
 */

const { mockGetTrainingServiceStatus } = vi.hoisted(() => ({
  mockGetTrainingServiceStatus: vi.fn(),
}));

// The router reads the status through `getTrainingServiceStatusState` (it needs `known` for the
// edge cache); both are driven from the one mock.
vi.mock('~/server/services/training.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TrainingService>()),
  getTrainingServiceStatus: mockGetTrainingServiceStatus,
  getTrainingServiceStatusState: async () => ({
    status: await mockGetTrainingServiceStatus(),
    known: true,
  }),
}));
// An anonymous caller does not get imageTraining (availability: ['user']).
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ imageTraining: false }),
}));

import { trainingRouter } from '~/server/routers/training.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function anonCtx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { imageTraining: false } as never,
    track: undefined,
  };
}

beforeEach(() => {
  mockGetTrainingServiceStatus.mockReset();
  mockGetTrainingServiceStatus.mockResolvedValue({
    available: false,
    message: 'operator note: paused for a test',
    blockedModels: ['some-model'],
  });
});

describe('training.getPublicStatus', () => {
  it('tells an anonymous caller that training is off, and nothing else', async () => {
    const caller = trainingRouter.createCaller(anonCtx() as never);
    await expect(caller.getPublicStatus()).resolves.toStrictEqual({ available: false });
  });

  it('reports training on when it is on', async () => {
    mockGetTrainingServiceStatus.mockResolvedValue({
      available: true,
      message: null,
      blockedModels: [],
    });
    const caller = trainingRouter.createCaller(anonCtx() as never);
    await expect(caller.getPublicStatus()).resolves.toStrictEqual({ available: true });
  });
});

describe('training.getStatus', () => {
  it('stays behind the imageTraining flag for an anonymous caller', async () => {
    const caller = trainingRouter.createCaller(anonCtx() as never);
    await expect(caller.getStatus()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<TRPCError>);
    expect(mockGetTrainingServiceStatus).not.toHaveBeenCalled();
  });
});
