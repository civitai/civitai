import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as CommentController from '~/server/controllers/comment.controller';

/**
 * A locked model closes its comment section. The write is scoped by comment id alone while
 * `modelId` is written through from the request, so an edit that names a different model both
 * escapes the lock and re-homes the comment onto the model it named. Both the model the request
 * names and the one the comment is stored under have to be checked.
 */

const { upsertCommentV2Handler } = vi.hoisted(() => ({
  upsertCommentV2Handler: vi.fn(async () => ({ id: 1 })),
}));

vi.mock('~/server/controllers/comment.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentController>()),
  upsertCommentHandler: upsertCommentV2Handler,
}));

import { commentRouter } from '../comment.router';

const read = dbMock.dbRead;

const author = { id: 2, isModerator: false, tier: 'free', username: 'author', onboarding: 0x1f };

function callerFor(user: unknown) {
  return commentRouter.createCaller({
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

/** The models this fake reports as locked, by id. */
let lockedModelIds = new Set<number>();

beforeEach(() => {
  vi.clearAllMocks();
  lockedModelIds = new Set();
  // The comment being edited is stored under model 10 and is not itself locked.
  read.comment.findFirst.mockResolvedValue({ locked: false, modelId: 10 });
  // Stands in for `WHERE id IN (…) AND locked` — returns a row only when one of the ids is locked.
  read.model.findFirst.mockImplementation(async (args: { where: { id: { in: number[] } } }) => {
    const hit = args.where.id.in.find((id) => lockedModelIds.has(id));
    return hit ? { id: hit } : null;
  });
  read.comment.findUnique.mockResolvedValue({ userId: author.id });
});

describe('comment.upsert — model lock', () => {
  it('refuses an edit under a locked model even when the request names an unlocked one', async () => {
    lockedModelIds.add(10);

    await expect(
      callerFor(author).upsert({ id: 5, modelId: 20, content: '<p>edited</p>' })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(upsertCommentV2Handler).not.toHaveBeenCalled();
  });

  it('refuses when the model the request names is locked', async () => {
    lockedModelIds.add(20);

    await expect(
      callerFor(author).upsert({ id: 5, modelId: 20, content: '<p>edited</p>' })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(upsertCommentV2Handler).not.toHaveBeenCalled();
  });

  it('allows an ordinary edit when neither model is locked', async () => {
    await expect(
      callerFor(author).upsert({ id: 5, modelId: 10, content: '<p>edited</p>' })
    ).resolves.toBeDefined();
    expect(upsertCommentV2Handler).toHaveBeenCalledTimes(1);
  });

  it('allows a new comment on an unlocked model', async () => {
    read.comment.findFirst.mockResolvedValue(null);

    await expect(
      callerFor(author).upsert({ modelId: 10, content: '<p>hello</p>' })
    ).resolves.toBeDefined();
    expect(upsertCommentV2Handler).toHaveBeenCalledTimes(1);
  });
});
