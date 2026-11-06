import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as ReactionController from '~/server/controllers/reaction.controller';

const { toggleReactionHandler } = vi.hoisted(() => ({
  toggleReactionHandler: vi.fn(async () => 'created'),
}));

vi.mock('~/server/controllers/reaction.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionController>()),
  toggleReactionHandler,
}));

import { commentRouter } from '../comment.router';
import { reactionRouter } from '../reaction.router';

const member = {
  id: 2,
  isModerator: false,
  tier: 'free',
  username: 'member',
  onboarding: 0x1f,
  emailVerified: new Date('2024-01-01'),
  muted: false,
  mutedAt: null,
  bannedAt: null,
  deletedAt: null,
};
const restricted = { ...member, muted: true, mutedAt: new Date('2024-01-02') };

function ctxFor(user: unknown) {
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
  } as never;
}

const toggleComment = (user: unknown) =>
  commentRouter.createCaller(ctxFor(user)).toggleReaction({ id: 5, reaction: 'Like' });
const toggleEntity = (user: unknown) =>
  reactionRouter
    .createCaller(ctxFor(user))
    .toggle({ entityType: 'commentOld', entityId: 5, reaction: 'Like' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('comment reactions use the guarded procedure', () => {
  it('reaches the handler for an ordinary member', async () => {
    await expect(toggleComment(member)).resolves.toBe('created');
    expect(toggleReactionHandler).toHaveBeenCalledTimes(1);
  });

  it('matches reaction.toggle for an account it refuses', async () => {
    await expect(toggleEntity(restricted)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: RESTRICTED_ACCOUNT_MESSAGE,
    });
    await expect(toggleComment(restricted)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: RESTRICTED_ACCOUNT_MESSAGE,
    });
    expect(toggleReactionHandler).not.toHaveBeenCalled();
  });
});
