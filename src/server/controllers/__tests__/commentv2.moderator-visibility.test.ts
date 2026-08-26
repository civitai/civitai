import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';

/**
 * Who the reads are told they are talking to.
 *
 * The `tosViolation` filtering lives in the service and defaults to "not a moderator", which fails
 * safe — a dropped argument hides removed comments from moderators too, and someone notices. The
 * direction that fails OPEN is this one: a handler that hardcodes or inverts `isModerator` serves
 * every ToS-removed comment to every viewer, and nothing else in the stack would say so.
 */

const getCommentsInfinite = vi.fn(async () => null);
const getCommentsThreadDetails2 = vi.fn(async () => null);
const getComment = vi.fn(async () => ({ id: 5, user: { id: 9 } }));
const getCommentCount = vi.fn(async () => 0);

vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  getCommentsInfinite: (...args: unknown[]) => getCommentsInfinite(...(args as [])),
  getCommentsThreadDetails2: (...args: unknown[]) => getCommentsThreadDetails2(...(args as [])),
  getComment: (...args: unknown[]) => getComment(...(args as [])),
  getCommentCount: (...args: unknown[]) => getCommentCount(...(args as [])),
  isViewerContentOwner: vi.fn(async () => false),
}));

const emptyPreference = { getCached: vi.fn(async () => [] as { id: number }[]) };
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: emptyPreference,
  BlockedUsers: emptyPreference,
  BlockedByUsers: emptyPreference,
}));

const {
  getCommentHandler,
  getCommentCountV2Handler,
  getCommentsInfiniteHandler,
  getCommentsThreadDetailsHandler,
} = await import('../commentv2.controller');

const input = { entityType: 'image', entityId: 1 } as never;
const ctxFor = (user: { id: number; isModerator?: boolean } | undefined) => ({ user } as never);

describe('CommentV2 handlers forward who is asking', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['a moderator', { id: 1, isModerator: true }, true],
    ['an ordinary signed-in user', { id: 2, isModerator: false }, false],
    ['a signed-out viewer', undefined, false],
  ])('getInfinite: %s', async (_label, user, expected) => {
    await getCommentsInfiniteHandler({ ctx: ctxFor(user), input });

    expect(getCommentsInfinite).toHaveBeenCalledWith(
      expect.objectContaining({ isModerator: expected })
    );
  });

  it.each([
    ['a moderator', { id: 1, isModerator: true }, true],
    ['an ordinary signed-in user', { id: 2, isModerator: false }, false],
    ['a signed-out viewer', undefined, false],
  ])('getThreadDetails: %s', async (_label, user, expected) => {
    await getCommentsThreadDetailsHandler({ ctx: ctxFor(user), input });

    expect(getCommentsThreadDetails2).toHaveBeenCalledWith(
      expect.objectContaining({ isModerator: expected })
    );
  });

  // The by-id read is a public procedure, so this is the one a deep link hits directly.
  it.each([
    ['a moderator', { id: 1, isModerator: true }, true],
    ['an ordinary signed-in user', { id: 2, isModerator: false }, false],
    ['a signed-out viewer', undefined, false],
  ])('getSingle: %s', async (_label, user, expected) => {
    await getCommentHandler({ ctx: ctxFor(user), input: { id: 5 } as never });

    expect(getComment).toHaveBeenCalledWith(expect.objectContaining({ isModerator: expected }));
  });

  // The count is what renders "show N replies". Forwarding the wrong answer here doesn't serve a
  // removed comment, it advertises one — an affordance that opens onto nothing.
  it.each([
    ['a moderator', { id: 1, isModerator: true }, true],
    ['an ordinary signed-in user', { id: 2, isModerator: false }, false],
    ['a signed-out viewer', undefined, false],
  ])('getCount: %s', async (_label, user, expected) => {
    await getCommentCountV2Handler({ ctx: ctxFor(user), input });

    expect(getCommentCount).toHaveBeenCalledWith(
      expect.objectContaining({ isModerator: expected })
    );
  });
});
