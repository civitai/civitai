import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as CommentV3Controller from '~/server/controllers/commentv3.controller';

// Every read-flipped comment surface writes through these two, so they carry the muted-account gate
// the client's hidden comment box only presents.

const { createCommentV3Handler, updateCommentV3Handler } = vi.hoisted(() => ({
  createCommentV3Handler: vi.fn(async () => 'created'),
  updateCommentV3Handler: vi.fn(async () => 'updated'),
}));

vi.mock('~/server/controllers/commentv3.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentV3Controller>()),
  createCommentV3Handler,
  updateCommentV3Handler,
}));

import { commentv3Router } from '../commentv3.router';

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
const muted = { ...member, muted: true, mutedAt: new Date('2024-01-02') };

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

const cases = [
  {
    name: 'commentv3.create',
    handler: createCommentV3Handler,
    expected: 'created',
    call: (user: unknown) =>
      commentv3Router
        .createCaller(ctxFor(user))
        .create({ entityType: 'comicChapter', entityId: 3, content: '<p>x</p>' }),
  },
  {
    name: 'commentv3.update',
    handler: updateCommentV3Handler,
    expected: 'updated',
    call: (user: unknown) =>
      commentv3Router.createCaller(ctxFor(user)).update({ id: 5, content: '<p>x</p>' }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('comment writes use the guarded procedure', () => {
  it.each(cases)('$name reaches the handler for an ordinary member', async (c) => {
    await expect(c.call(member)).resolves.toBe(c.expected);
    expect(c.handler).toHaveBeenCalledTimes(1);
  });

  it.each(cases)('$name refuses a muted account', async (c) => {
    await expect(c.call(muted)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: RESTRICTED_ACCOUNT_MESSAGE,
    });
    expect(c.handler).not.toHaveBeenCalled();
  });
});
