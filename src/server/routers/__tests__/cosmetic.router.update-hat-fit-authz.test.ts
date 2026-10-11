import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// A hat edit changes the hat on every card wearing it, so only a moderator may save one. This
// drives the real router so the procedure's own middleware decides.

const { mockUpdate } = vi.hoisted(() => ({
  mockUpdate: vi.fn(async ({ id }: { id: number }) => ({ id, data: {} })),
}));
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  updateEventHatFit: mockUpdate,
}));

const { cosmeticRouter } = await import('~/server/routers/cosmetic.router');

function caller(user: unknown) {
  return cosmeticRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const member = { id: 2, isModerator: false, tier: 'free', username: 'member', onboarding: 0x1f };
const EDIT = { id: 3080, fit: { tilt: -30 } };

beforeEach(() => vi.clearAllMocks());

describe('saving a hat edit', () => {
  it('is refused to a signed-in member, and nothing is saved', async () => {
    await expect(caller(member).updateEventHatFit(EDIT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('is refused to a signed-out caller, and nothing is saved', async () => {
    await expect(caller(undefined).updateEventHatFit(EDIT)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('is saved for a moderator', async () => {
    await expect(caller(mod).updateEventHatFit(EDIT)).resolves.toEqual({ id: 3080, data: {} });
    expect(mockUpdate).toHaveBeenCalledWith({ id: 3080, fit: { tilt: -30 } });
  });
});
