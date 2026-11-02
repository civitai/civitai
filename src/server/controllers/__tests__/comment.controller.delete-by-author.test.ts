import { beforeEach, expect, it, vi } from 'vitest';
import type * as CommentService from '~/server/services/comment.service';

// A legacy comment kept for a hold on its author's own delete is marked so a ToS restore leaves it
// down; one a moderator deletes is not.

const { deleteCommentById } = vi.hoisted(() => ({
  deleteCommentById: vi.fn(async ({ id }: { id: number }) => ({ id })),
}));

vi.mock('~/server/services/comment.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentService>()),
  deleteCommentById,
}));

import { deleteUserCommentHandler } from '../comment.controller';

const ctxFor = (isModerator: boolean) =>
  ({
    user: { id: 2, isModerator },
    track: { commentEvent: vi.fn(async () => undefined) },
  } as never);

beforeEach(() => vi.clearAllMocks());

it.each([
  [false, true],
  [true, false],
])('a delete by a moderator=%s is byAuthor=%s', async (isModerator, byAuthor) => {
  await deleteUserCommentHandler({ input: { id: 5 }, ctx: ctxFor(isModerator) });
  expect(deleteCommentById).toHaveBeenCalledWith({ id: 5, byAuthor });
});
