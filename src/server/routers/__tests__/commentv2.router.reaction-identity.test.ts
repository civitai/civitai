import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { HIDDEN_REACTOR_ID } from '~/shared/constants/reaction-privacy.constants';
import type * as CommentV2Controller from '~/server/controllers/commentv2.controller';

const VIEWER = 7;
const OTHER = 8;

const comment = () => ({
  id: 1,
  reactions: [
    { userId: VIEWER, reaction: 'Like' },
    { userId: OTHER, reaction: 'Like' },
  ],
});

const handlers = vi.hoisted(() => ({
  getCommentsInfiniteHandler: vi.fn(),
  getCommentHandler: vi.fn(),
}));

vi.mock('~/server/controllers/commentv2.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentV2Controller>()),
  ...handlers,
}));

import { commentv2Router } from '../commentv2.router';

function callerFor(user: unknown) {
  return commentv2Router.createCaller({
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

const viewer = { id: VIEWER, isModerator: false, tier: 'free', username: 'v', onboarding: 0x1f };
const moderator = { ...viewer, isModerator: true };

beforeEach(() => {
  handlers.getCommentsInfiniteHandler.mockImplementation(async () => ({
    comments: [comment()],
    targetComment: comment(),
  }));
  handlers.getCommentHandler.mockImplementation(async () => comment());
});

const ids = (c: { reactions: { userId: number }[] }) => c.reactions.map((r) => r.userId);

describe('commentv2 reads return only the viewer’s own reaction identity', () => {
  it('getInfinite: every row kept, other users’ ids replaced', async () => {
    const page = (await callerFor(viewer).getInfinite({ entityId: 1, entityType: 'image' })) as {
      comments: ReturnType<typeof comment>[];
      targetComment: ReturnType<typeof comment>;
    };
    expect(ids(page.comments[0])).toEqual([VIEWER, HIDDEN_REACTOR_ID]);
    expect(ids(page.targetComment)).toEqual([VIEWER, HIDDEN_REACTOR_ID]);
  });

  it('getSingle, signed out: no ids at all', async () => {
    const result = (await callerFor(undefined).getSingle({ id: 1 })) as ReturnType<typeof comment>;
    expect(ids(result)).toEqual([HIDDEN_REACTOR_ID, HIDDEN_REACTOR_ID]);
  });

  it('a moderator keeps the full view', async () => {
    const result = (await callerFor(moderator).getSingle({ id: 1 })) as ReturnType<typeof comment>;
    expect(ids(result)).toEqual([VIEWER, OTHER]);
  });
});
