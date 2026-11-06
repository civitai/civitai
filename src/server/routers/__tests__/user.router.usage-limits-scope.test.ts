import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UsageLimitsService from '~/server/services/usage-limits.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// The real service behind a spy, so the moderator case sees what the procedure actually returns.
const { getUsageLimits } = vi.hoisted(() => ({ getUsageLimits: vi.fn() }));
vi.mock('~/server/services/usage-limits.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUsageLimits,
}));
const real = await vi.importActual<typeof UsageLimitsService>(
  '~/server/services/usage-limits.service'
);

import { userRouter } from '~/server/routers/user.router';

const REQ = { headers: {}, socket: {} };
const USER = { id: 42, tier: 'free', username: 'u', muted: false, onboarding: 0xff };
const MODERATOR = { ...USER, isModerator: true, createdAt: new Date(2020, 0, 1) };

const caller = (tokenScope: number, user: object = USER) =>
  userRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: tokenScope === TokenScope.Full ? null : 5,
    tokenScope,
    req: REQ,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { userActivity: vi.fn() },
  } as never);

beforeEach(() => {
  getUsageLimits.mockReset();
  getUsageLimits.mockImplementation(real.getUsageLimits);
});

describe('user.getUsageLimits token scope', () => {
  it.each([
    ['a session', TokenScope.Full],
    ['a UserRead token', TokenScope.UserRead],
    ['a MediaWrite token', TokenScope.MediaWrite],
    ['a token with both', TokenScope.UserRead | TokenScope.MediaWrite],
  ])('serves %s, forwarding its token scope', async (_label, scope) => {
    await expect(caller(scope).getUsageLimits({ ids: ['posts.daily'] })).resolves.toHaveProperty(
      'limits'
    );
    expect(getUsageLimits).toHaveBeenCalledWith({
      ids: ['posts.daily'],
      user: expect.objectContaining({ id: 42 }),
      req: REQ,
      tokenScope: scope,
    });
  });

  it('refuses a token with neither scope', async () => {
    await expect(
      caller(TokenScope.ModelsRead | TokenScope.ModelsWrite).getUsageLimits()
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getUsageLimits).not.toHaveBeenCalled();
  });

  it("shows a moderator's exemption to a session but regular rows to a MediaWrite-only token", async () => {
    const session = await caller(TokenScope.Full, MODERATOR).getUsageLimits();
    expect(session.limits).toEqual([expect.objectContaining({ id: 'posts.daily', limit: null })]);

    const media = await caller(TokenScope.MediaWrite, MODERATOR).getUsageLimits();
    expect(media.limits).toEqual([
      expect.objectContaining({ id: 'posts.daily', limit: 20, used: 0, remaining: 20 }),
    ]);
  });
});
