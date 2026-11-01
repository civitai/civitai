import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as CommentController from '~/server/controllers/comment.controller';

/**
 * An author's own delete can keep a legacy comment for a hold by hiding it for ToS. To its author it
 * is gone: an edit of it, a reply to it and another delete answer as for a missing comment.
 */

const { upsertCommentHandler, deleteUserCommentHandler } = vi.hoisted(() => ({
  upsertCommentHandler: vi.fn(async () => ({ id: 1 })),
  deleteUserCommentHandler: vi.fn(async () => undefined),
}));

vi.mock('~/server/controllers/comment.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentController>()),
  upsertCommentHandler,
  deleteUserCommentHandler,
}));

import { commentRouter } from '../comment.router';

const read = dbMock.dbRead;

const author = { id: 2, isModerator: false, tier: 'free', username: 'author', onboarding: 0x1f };
const moderator = { ...author, id: 3, isModerator: true };

const callerFor = (user: unknown) =>
  commentRouter.createCaller({
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

/** Comment 5 is the author's; whether it is hidden for ToS is set per test. */
let hidden = false;

beforeEach(() => {
  vi.clearAllMocks();
  hidden = false;
  read.comment.findFirst.mockResolvedValue({ locked: false, modelId: 10 });
  read.model.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.comment.findUnique.mockImplementation((async (args: { where: { id: number } }) =>
    args.where.id === 5 ? { userId: author.id, tosViolation: hidden } : null) as never);
});

const edit = (user: unknown) =>
  callerFor(user).upsert({ id: 5, modelId: 10, content: '<p>edited</p>' });
const reply = (user: unknown) =>
  callerFor(user).upsert({ modelId: 10, parentId: 5, content: '<p>reply</p>' });
const remove = (user: unknown) => callerFor(user).delete({ id: 5 });

describe('a legacy comment hidden for ToS', () => {
  it.each([
    ['edit', edit],
    ['reply', reply],
    ['delete', remove],
  ])('answers its author as missing on %s', async (_, call) => {
    hidden = true;
    await expect(call(author)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(upsertCommentHandler).not.toHaveBeenCalled();
    expect(deleteUserCommentHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['edit', edit],
    ['reply', reply],
  ])('lets a moderator %s it (control)', async (_, call) => {
    hidden = true;
    await expect(call(moderator)).resolves.toBeDefined();
    expect(upsertCommentHandler).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['edit', edit],
    ['reply', reply],
  ])('lets its author %s it while it is live (control)', async (_, call) => {
    await expect(call(author)).resolves.toBeDefined();
    expect(upsertCommentHandler).toHaveBeenCalledTimes(1);
  });
});
