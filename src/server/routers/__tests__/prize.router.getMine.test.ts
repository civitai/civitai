import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PrizeServiceMod from '~/server/services/prize.service';

/**
 * /prizes calls `prize.getMine` with no input, but `authedCacheBypassLink` (src/utils/trpc.ts)
 * turns a no-input browser call into `{ authed: true }` for a signed-in user and `{}` otherwise —
 * never `undefined`. A schema that requires its filter fields whenever an object arrives rejects
 * both with BAD_REQUEST, and the page showed "You have no prizes yet" to everyone. Keep the
 * filter fields optional.
 */

const h = vi.hoisted(() => ({ getMyPrizes: vi.fn() }));

vi.mock('~/server/services/prize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrizeServiceMod>()),
  getMyPrizes: (...a: unknown[]) => h.getMyPrizes(...a),
}));

import { appRouter } from '../index';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = () =>
  appRouter.createCaller({
    acceptableOrigin: true,
    user: { id: 42, isModerator: false, onboarding: 0xffff, muted: false },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.getMyPrizes.mockResolvedValue([{ id: 7 }]);
});

describe('prize.getMine accepts the input the browser link actually sends', () => {
  it.each([
    ['{ authed: true }', { authed: true }],
    ['{}', {}],
  ])('a no-input call arriving as %s returns the unfiltered list', async (_, input) => {
    await expect(caller().prize.getMine(input as never)).resolves.toEqual([{ id: 7 }]);
    const [arg] = h.getMyPrizes.mock.calls[0];
    expect(arg).toMatchObject({ userId: 42 });
    expect(arg.sourceType).toBeUndefined();
    expect(arg.sourceId).toBeUndefined();
  });

  it('still filters by source when one is given', async () => {
    await caller().prize.getMine({ sourceType: 'Crucible', sourceId: 5, authed: true } as never);
    expect(h.getMyPrizes).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, sourceType: 'Crucible', sourceId: 5 })
    );
  });
});
