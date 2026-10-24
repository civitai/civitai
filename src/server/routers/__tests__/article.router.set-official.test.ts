import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `article.setOfficial` marks an article as published by Civitai. It is a PROVENANCE
 * claim, so the whole feature is the authorization: a badge a user can put on their own
 * article is worse than no badge.
 *
 * This drives the REAL router through `createCaller`, so the middleware wiring is what
 * decides — not a source scan and not the service's own recheck. The design this replaced
 * carried the marker on a tag, and tags attach by name through `connectOrCreate`, which is
 * exactly the shape that made it forgeable.
 */

const { mockSetArticleOfficial } = vi.hoisted(() => ({ mockSetArticleOfficial: vi.fn() }));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setArticleOfficial: mockSetArticleOfficial,
}));

import { articleRouter } from '../article.router';
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

const moderator = { id: 1, isModerator: true, tier: 'free', muted: false, bannedAt: null };
const member = { id: 2, isModerator: false, tier: 'free', muted: false, bannedAt: null };

describe('article.setOfficial', () => {
  beforeEach(() => {
    mockSetArticleOfficial.mockReset();
    mockSetArticleOfficial.mockResolvedValue({ id: 7, isOfficial: true });
  });

  it('rejects a signed-in member, and does not reach the service', async () => {
    const caller = articleRouter.createCaller(fakeCtx(member) as never);

    await expect(caller.setOfficial({ id: 7, isOfficial: true })).rejects.toBeInstanceOf(TRPCError);
    expect(mockSetArticleOfficial).not.toHaveBeenCalled();
  });

  it('rejects an anonymous caller, and does not reach the service', async () => {
    const caller = articleRouter.createCaller(fakeCtx(undefined) as never);

    await expect(caller.setOfficial({ id: 7, isOfficial: true })).rejects.toBeInstanceOf(TRPCError);
    expect(mockSetArticleOfficial).not.toHaveBeenCalled();
  });

  // The control for both refusals above. Without it they pass for a route that rejects
  // everyone, including moderators — which would read as "well guarded" and ship a
  // feature nobody can use.
  it('lets a moderator through, and passes the moderator flag to the service', async () => {
    const caller = articleRouter.createCaller(fakeCtx(moderator) as never);

    await expect(caller.setOfficial({ id: 7, isOfficial: true })).resolves.toEqual({
      id: 7,
      isOfficial: true,
    });
    expect(mockSetArticleOfficial).toHaveBeenCalledWith({
      id: 7,
      isOfficial: true,
      isModerator: true,
    });
  });

  // Unmarking is the same boundary as marking: a member who could clear the flag could
  // strip provenance off a Civitai article.
  it('rejects a member unmarking, too', async () => {
    const caller = articleRouter.createCaller(fakeCtx(member) as never);

    await expect(caller.setOfficial({ id: 7, isOfficial: false })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockSetArticleOfficial).not.toHaveBeenCalled();
  });
});
