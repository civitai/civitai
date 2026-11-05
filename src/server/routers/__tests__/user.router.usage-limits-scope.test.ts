import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const { getUsageLimits } = vi.hoisted(() => ({
  getUsageLimits: vi.fn(async () => ({ limits: [] })),
}));
vi.mock('~/server/services/usage-limits.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUsageLimits,
}));

import { userRouter } from '~/server/routers/user.router';

const caller = (tokenScope: number) =>
  userRouter.createCaller({
    acceptableOrigin: true,
    user: { id: 42, tier: 'free', username: 'u', muted: false, onboarding: 0xff },
    apiKeyId: tokenScope === TokenScope.Full ? null : 5,
    tokenScope,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { userActivity: vi.fn() },
  } as never);

beforeEach(() => getUsageLimits.mockClear());

describe('user.getUsageLimits token scope', () => {
  it.each([
    ['a session', TokenScope.Full],
    ['a UserRead token', TokenScope.UserRead],
    ['a MediaWrite token', TokenScope.MediaWrite],
    ['a token with both', TokenScope.UserRead | TokenScope.MediaWrite],
  ])('serves %s', async (_label, scope) => {
    await expect(caller(scope).getUsageLimits({ ids: ['posts.daily'] })).resolves.toEqual({
      limits: [],
    });
    expect(getUsageLimits).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['posts.daily'], user: expect.objectContaining({ id: 42 }) })
    );
  });

  it('refuses a token with neither scope', async () => {
    await expect(
      caller(TokenScope.ModelsRead | TokenScope.ModelsWrite).getUsageLimits()
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getUsageLimits).not.toHaveBeenCalled();
  });
});
