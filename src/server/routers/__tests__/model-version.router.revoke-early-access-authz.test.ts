import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Only a moderator may revoke a buyer's early access; driven through `createCaller`. */

const { mockRevoke } = vi.hoisted(() => ({
  mockRevoke: vi.fn(async () => ({ revoked: true as const, permissions: 3 })),
}));

vi.mock('~/server/services/model-version-access-revoke.service', () => ({
  moderatorRevokeEarlyAccess: mockRevoke,
}));

const { modelVersionRouter } = await import('~/server/routers/model-version.router');

const ctx = (isModerator: boolean) =>
  ({
    acceptableOrigin: true,
    user: { id: 7, isModerator, tier: 'free', username: 'someone', onboarding: 0x1f },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);

// A fresh object per call: the router's middleware writes into the input it is handed.
const input = () => ({ userId: 77, modelVersionId: 501, reason: 'bought the wrong version' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('modelVersion.revokeUserEarlyAccess', () => {
  it('refuses a user who is not a moderator', async () => {
    await expect(
      modelVersionRouter.createCaller(ctx(false)).revokeUserEarlyAccess(input())
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('lets a moderator through, as the moderator on the record', async () => {
    await expect(
      modelVersionRouter.createCaller(ctx(true)).revokeUserEarlyAccess(input())
    ).resolves.toEqual({ revoked: true, permissions: 3 });
    expect(mockRevoke).toHaveBeenCalledWith({ ...input(), moderatorId: 7 });
  });

  it('refuses a revoke with no reason', async () => {
    await expect(
      modelVersionRouter.createCaller(ctx(true)).revokeUserEarlyAccess({ ...input(), reason: '  ' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
