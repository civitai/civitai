import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as MoveAsset from '~/server/services/orchestrator/training/move-asset';

/**
 * `training.moveAsset` lets a moderator act on someone else's model version, so the moderator flag
 * the service receives must come from the session, never default to true.
 */

const { mockMoveAsset } = vi.hoisted(() => ({ mockMoveAsset: vi.fn() }));

vi.mock('~/server/services/orchestrator/training/move-asset', async (importOriginal) => ({
  ...(await importOriginal<typeof MoveAsset>()),
  moveAsset: mockMoveAsset,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ imageTraining: true }),
}));

import { trainingRouter } from '~/server/routers/training.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const input = {
  url: 'https://orchestration.civitai.com/v2/consumer/blobs/ABC.safetensors',
  modelVersionId: 321,
};

beforeEach(() => {
  mockMoveAsset.mockReset();
  mockMoveAsset.mockResolvedValue({ newUrl: 'x', fileSize: 1 });
});

describe('training.moveAsset router wiring', () => {
  it.each([
    ['a member', { id: 2, isModerator: false }, false],
    ['a user whose session carries no moderator flag', { id: 2 }, false],
    ['a moderator', { id: 1, isModerator: true }, true],
  ])('passes the session moderator flag through for %s', async (_label, user, isModerator) => {
    const caller = trainingRouter.createCaller(
      fakeCtx({ tier: 'free', muted: false, bannedAt: null, ...user }) as never
    );
    await caller.moveAsset({ ...input });
    expect(mockMoveAsset).toHaveBeenCalledTimes(1);
    expect(mockMoveAsset.mock.calls[0][0]).toMatchObject({ ...input, userId: user.id });
    expect(mockMoveAsset.mock.calls[0][0].isModerator).toBe(isModerator);
  });
});
