import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommentV2Controller from '~/server/controllers/commentv2.controller';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as ReadService from '~/server/services/commentv3/read.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as UserService from '~/server/services/user.service';

/**
 * What the v3 handlers tell the read service about the viewer, and which entity they gate on.
 * The read service trusts both: it filters by `excludedUserIds` and `isModerator` as given, so a
 * handler that drops an exclusion list or inverts the moderator flag serves comments the viewer
 * must not see, and the SQL tests, which build the viewer by hand, cannot notice.
 */

const page = { comments: [], rootIds: [], children: {}, nextCursor: null };
const read = vi.hoisted(() => ({
  getCommentSection: vi.fn(),
  getCommentReplies: vi.fn(),
  getCommentThread: vi.fn(),
  getCommentEntity: vi.fn(),
  getCommentLock: vi.fn(async () => ({ locked: false })),
}));
vi.mock('~/server/services/commentv3/read.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReadService>()),
  ...read,
}));

const gate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/controllers/commentv2.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentV2Controller>()),
  assertCommentEntityVisible: gate,
}));

const prefs = vi.hoisted(() => ({
  hidden: [] as number[],
  blocked: [] as number[],
  blockedBy: [] as number[],
}));
const cached = (list: () => number[]) => ({
  getCached: vi.fn(async () => list().map((id) => ({ id }))),
});
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: cached(() => prefs.hidden),
  BlockedUsers: cached(() => prefs.blocked),
  BlockedByUsers: cached(() => prefs.blockedBy),
}));

const ownsContent = vi.hoisted(() => vi.fn(async () => false));
vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  isViewerContentOwner: ownsContent,
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getCosmeticsAndProfilePicturesForUsers: vi.fn(async () => () => ({})),
}));

const { getCommentSectionHandler, getCommentRepliesHandler, getCommentThreadHandler } =
  await import('../commentv3.controller');

const ctxFor = (user?: { id: number; isModerator?: boolean }) => ({ user } as never);
const sectionInput = { entityType: 'article', entityId: 10, sort: 'Oldest' } as never;
const viewerOf = (fn: typeof read.getCommentSection, at = 2) => fn.mock.calls[0][at];

beforeEach(() => {
  vi.clearAllMocks();
  prefs.hidden = [11];
  prefs.blocked = [12];
  prefs.blockedBy = [13];
  ownsContent.mockResolvedValue(false);
  read.getCommentSection.mockResolvedValue(page);
  read.getCommentReplies.mockResolvedValue(page);
});

describe('getSection tells the read service who is asking', () => {
  it.each([
    ['a moderator', { id: 1, isModerator: true }, true],
    ['an ordinary signed-in user', { id: 2, isModerator: false }, false],
    ['a signed-out viewer', undefined, false],
  ])('%s', async (_label, user, isModerator) => {
    await getCommentSectionHandler({ ctx: ctxFor(user), input: sectionInput });
    expect(viewerOf(read.getCommentSection)).toMatchObject({ isModerator, userId: user?.id });
  });

  it('excludes hidden, blocked and blocked-by authors', async () => {
    await getCommentSectionHandler({ ctx: ctxFor({ id: 2 }), input: sectionInput });
    expect([...viewerOf(read.getCommentSection).excludedUserIds].sort()).toEqual([11, 12, 13]);
  });

  it('still shows the content owner a blocker’s comments on their own content', async () => {
    ownsContent.mockResolvedValue(true);
    await getCommentSectionHandler({ ctx: ctxFor({ id: 2 }), input: sectionInput });
    expect([...viewerOf(read.getCommentSection).excludedUserIds].sort()).toEqual([11, 12]);
  });

  it('gates on the entity it was asked for', async () => {
    await getCommentSectionHandler({ ctx: ctxFor({ id: 2 }), input: sectionInput });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'article', entityId: 10 }),
      expect.anything()
    );
  });
});

describe('getReplies and getThread take the entity from the stored comment', () => {
  it('gates replies on the comment’s own entity', async () => {
    read.getCommentEntity.mockResolvedValue({ entityType: 'image', entityId: 7, path: '5' });
    await getCommentRepliesHandler({
      ctx: ctxFor({ id: 2 }),
      input: { parentId: 5, sort: 'Oldest' } as never,
    });
    expect(gate).toHaveBeenCalledWith(
      { entityType: 'image', entityId: 7, path: '5' },
      expect.anything()
    );
  });

  it('is not found when the comment does not exist, or the read finds nothing to show', async () => {
    const input = { commentId: 5, entityType: 'article', entityId: 10, sort: 'Oldest' } as never;
    read.getCommentEntity.mockResolvedValue(null);
    await expect(getCommentThreadHandler({ ctx: ctxFor(), input })).rejects.toThrow(
      'Comment not found'
    );
    expect(gate).not.toHaveBeenCalled();

    read.getCommentEntity.mockResolvedValue({ entityType: 'article', entityId: 10, path: '5' });
    read.getCommentThread.mockResolvedValue(null);
    await expect(getCommentThreadHandler({ ctx: ctxFor(), input })).rejects.toThrow(
      'Comment not found'
    );
  });

  it('asks the read for the page’s entity, so another entity’s comment is not found', async () => {
    read.getCommentEntity.mockResolvedValue({ entityType: 'article', entityId: 99, path: '5' });
    read.getCommentThread.mockResolvedValue(null);
    const input = { commentId: 5, entityType: 'article', entityId: 10, sort: 'Oldest' } as never;
    await expect(getCommentThreadHandler({ ctx: ctxFor(), input })).rejects.toThrow();
    expect(read.getCommentThread.mock.calls[0][3]).toMatchObject({
      entity: { entityType: 'article', entityId: 10 },
    });
  });
});
