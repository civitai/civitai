import type { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrainingDataShare from '~/server/services/training-data-share.service';

/**
 * `training.setStudioDatasetShare` is the owner's own click, the one way to raise a share. It must
 * limit the write to the caller's own model: without `ownerId`, any signed-in user could share
 * another user's dataset.
 */

const { mockSetStudioDatasetShare } = vi.hoisted(() => ({ mockSetStudioDatasetShare: vi.fn() }));

vi.mock('~/server/services/training-data-share.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TrainingDataShare>()),
  setStudioDatasetShare: mockSetStudioDatasetShare,
}));

import { trainingRouter } from '~/server/routers/training.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const USER = 42;

function signedInCtx() {
  return {
    acceptableOrigin: true,
    // Every onboarding step done, as guardedProcedure requires.
    user: { id: USER, isModerator: false, onboarding: 0x7fffffff },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {}, method: 'POST' } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const input = { modelVersionId: 10, ownRights: true, shareDataset: true };

beforeEach(() => {
  mockSetStudioDatasetShare.mockReset().mockResolvedValue(true);
});

describe('training.setStudioDatasetShare', () => {
  it("raises the share on the caller's own model only", async () => {
    await trainingRouter.createCaller(signedInCtx() as never).setStudioDatasetShare(input);
    expect(mockSetStudioDatasetShare).toHaveBeenCalledWith(
      10,
      { ownRights: true, shareDataset: true },
      { raise: true, ownerId: USER }
    );
  });

  it('is not-found when no dataset of the caller matches', async () => {
    mockSetStudioDatasetShare.mockResolvedValue(false);
    await expect(
      trainingRouter.createCaller(signedInCtx() as never).setStudioDatasetShare(input)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<TRPCError>);
  });
});
