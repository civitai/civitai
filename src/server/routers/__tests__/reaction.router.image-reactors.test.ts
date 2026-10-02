import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as ImageReactorsService from '~/server/services/image-reactors.service';

const { getImageReactors } = vi.hoisted(() => ({
  getImageReactors: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
}));

vi.mock('~/server/services/image-reactors.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageReactorsService>()),
  getImageReactors,
}));

import { reactionRouter } from '../reaction.router';

const user = {
  id: 5,
  isModerator: false,
  tier: 'free',
  username: 'owner',
  onboarding: 0x1f,
  muted: false,
};

function caller({ apiKeyId = null as number | null, tokenScope = TokenScope.Full as number } = {}) {
  return reactionRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId,
    tokenScope,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reaction.getImageReactors', () => {
  it('asks about the requested image on behalf of the SESSION user, never an input one', async () => {
    await caller().getImageReactors({ id: 42, userId: 999 } as never);

    expect(getImageReactors).toHaveBeenCalledTimes(1);
    expect(getImageReactors).toHaveBeenCalledWith({ imageId: 42, userId: user.id });
  });

  // Deliberately no `requiredScope`: the narrow scopes' consent text ("Read profile, settings & email", "View
  // images...") does not tell a user an app can list who reacted to their content. Adding one widens that.
  const fullBits = Array.from({ length: 25 }, (_, i) => 1 << i).filter(
    (bit) => (TokenScope.Full & bit) !== 0
  );
  it.each(fullBits)(
    'refuses a key holding every scope except bit %i: any requiredScope short of Full lets one through',
    async (bit) => {
      const scoped = caller({ apiKeyId: 1, tokenScope: TokenScope.Full & ~bit });

      await expect(scoped.getImageReactors({ id: 42 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(getImageReactors).not.toHaveBeenCalled();
    }
  );

  it('serves a full-access key', async () => {
    await caller({ apiKeyId: 1, tokenScope: TokenScope.Full }).getImageReactors({ id: 42 });
    expect(getImageReactors).toHaveBeenCalledWith({ imageId: 42, userId: user.id });
  });

  it('refuses a signed-out caller', async () => {
    const anon = reactionRouter.createCaller({
      acceptableOrigin: true,
      user: undefined,
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      req: { headers: {} } as never,
      res: { setHeader: () => undefined } as never,
      cache: { edgeTTL: 0 },
      features: {} as never,
      track: undefined,
    } as never);

    await expect(anon.getImageReactors({ id: 42 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(getImageReactors).not.toHaveBeenCalled();
  });
});
