import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommentOwnerService from '~/server/services/comment-owner.service';
import type * as ReadService from '~/server/services/commentv3/read.service';
import type * as Surfaces from '~/server/services/commentv3/surfaces';
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
  resolveModelPageCommentId: vi.fn(async (_db: unknown, _modelId: number, id: number) => id),
  countSectionComments: vi.fn(async () => ({ visible: 20, hidden: 3 })),
  getTimedComments: vi.fn<(...args: unknown[]) => Promise<ReadService.TimedComment[]>>(
    async () => []
  ),
}));
vi.mock('~/server/services/commentv3/read.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReadService>()),
  ...read,
}));

const gate = vi.hoisted(() => vi.fn(async (_entity: unknown, _ctx: unknown) => undefined));
vi.mock('~/server/services/commentv3/surfaces', async (importOriginal) => {
  const actual = await importOriginal<typeof Surfaces>();
  return {
    ...actual,
    commentSurface: (entityType: string) => ({
      ...actual.commentSurface(entityType),
      assertVisible: (entityId: number, ctx: unknown) => gate({ entityType, entityId }, ctx),
    }),
  };
});

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
vi.mock('~/server/services/comment-owner.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentOwnerService>()),
  isViewerContentOwner: ownsContent,
}));

const authors = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => (_id: number) => ({}))
);
const pictures = vi.hoisted(() =>
  vi.fn<(ids: number[]) => Promise<Record<number, unknown>>>(async () => ({}))
);
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getCosmeticsAndProfilePicturesForUsers: authors,
  getProfilePicturesForUsers: pictures,
}));

const section = vi.hoisted(() => ({
  getSectionMuted: vi.fn(async () => ({ muted: false, exists: true })),
  toggleSectionMute: vi.fn(async () => ({ muted: true, exists: true })),
  getCommentMuted: vi.fn(async () => ({ muted: false, viaAncestor: false, canMute: true })),
  toggleCommentMute: vi.fn(async () => ({ muted: true })),
}));

const stored = vi.hoisted(() =>
  vi.fn(
    async (..._a: unknown[]): Promise<unknown> => ({
      id: 5,
      entityType: 'bounty',
      entityId: 7,
      tosViolation: false,
    })
  )
);
vi.mock('~/server/services/commentv3/write.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getV3WriteComment: stored,
}));
vi.mock('~/server/services/commentv3/section.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...section,
}));

const {
  getCommentSectionHandler,
  getCommentRepliesHandler,
  getCommentThreadHandler,
  getTimedCommentsHandler,
  getSectionLockHandler,
  getSectionMutedHandler,
  toggleSectionMuteHandler,
  getCommentMutedHandler,
  toggleCommentMuteHandler,
} = await import('../commentv3.controller');

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

describe('getTimed: a song’s timed comments for the player', () => {
  const songCtx = (music: boolean) => ({ user: { id: 2 }, features: { music } } as never);
  const timed = (input = { imageId: 20 }, music = true) =>
    getTimedCommentsHandler({ ctx: songCtx(music), input });

  it('reads the image’s section with the section’s gate and exclusions', async () => {
    await timed();
    expect(gate).toHaveBeenCalledWith({ entityType: 'image', entityId: 20 }, expect.anything());
    const [, entity, viewer] = read.getTimedComments.mock.calls[0] as unknown[];
    expect(entity).toEqual({ entityType: 'image', entityId: 20 });
    expect([...(viewer as { excludedUserIds: number[] }).excludedUserIds].sort()).toEqual([
      11, 12, 13,
    ]);
  });

  it('answers each comment as plain text cut to a label, with its author’s picture', async () => {
    read.getTimedComments.mockResolvedValueOnce([
      {
        id: 1,
        timestampSec: 4,
        content: '<p>so <b>good</b> &amp; &quot;loud&quot;</p>',
        user: { id: 7, username: 'a', image: null },
      },
      {
        id: 2,
        timestampSec: 9,
        content: `<p>${'x'.repeat(300)}</p>`,
        user: { id: 8, username: 'b', image: null },
      },
    ]);
    pictures.mockResolvedValueOnce({ 7: { id: 70 } });
    const [first, second] = await timed();
    // Stored comments are HTML: the label shows their entities as the characters they stand for.
    expect(first).toMatchObject({ id: 1, timestampSec: 4, text: 'so good & "loud"' });
    expect(first.user).toMatchObject({ id: 7, profilePicture: { id: 70 } });
    expect(second.text).toHaveLength(140);
    expect(second.text.endsWith('…')).toBe(true);
    expect(second.user.profilePicture).toBeNull();
  });

  it('answers none, and reads nothing, while songs are off for the viewer', async () => {
    expect(await timed(undefined, false)).toEqual([]);
    expect(read.getTimedComments).not.toHaveBeenCalled();
  });
});

describe('getSection on a surface that leaves hidden comments out', () => {
  const model = (over: Record<string, unknown> = {}) =>
    ({ entityType: 'model', entityId: 7, sort: 'Newest', ...over } as never);
  const hiddenOption = () => read.getCommentSection.mock.calls[0][3].hidden;

  it('leaves them out of the list and counts both on the first page', async () => {
    const result = await getCommentSectionHandler({ ctx: ctxFor({ id: 2 }), input: model() });
    expect(hiddenOption()).toBe('exclude');
    expect(read.countSectionComments).toHaveBeenCalledTimes(1);
    expect(result.counts).toEqual({ visible: 20, hidden: 3 });
  });

  it('lists only them when asked', async () => {
    await getCommentSectionHandler({ ctx: ctxFor({ id: 2 }), input: model({ hidden: true }) });
    expect(hiddenOption()).toBe('only');
  });

  it('counts nothing on a later page', async () => {
    const result = await getCommentSectionHandler({
      ctx: ctxFor({ id: 2 }),
      input: model({ cursor: 'next' }),
    });
    expect(read.countSectionComments).not.toHaveBeenCalled();
    expect(result.counts).toBeUndefined();
  });

  it('leaves any other surface as it was, whatever the input asks', async () => {
    const result = await getCommentSectionHandler({
      ctx: ctxFor({ id: 2 }),
      input: { ...(sectionInput as object), hidden: true } as never,
    });
    expect(hiddenOption()).toBeUndefined();
    expect(read.countSectionComments).not.toHaveBeenCalled();
    expect(result.counts).toBeUndefined();
  });
});

describe('getReplies and getThread take the entity from the stored comment', () => {
  it('gates replies on the comment’s own entity', async () => {
    read.getCommentEntity.mockResolvedValue({ entityType: 'image', entityId: 7, path: '5' });
    await getCommentRepliesHandler({
      ctx: ctxFor({ id: 2 }),
      input: { parentId: 5, sort: 'Oldest' } as never,
    });
    expect(gate).toHaveBeenCalledWith({ entityType: 'image', entityId: 7 }, expect.anything());
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

  it('reads a model-page link’s comment by the id it resolves to, an old v1 id included', async () => {
    read.resolveModelPageCommentId.mockResolvedValueOnce(950);
    read.getCommentEntity.mockResolvedValue({ entityType: 'model', entityId: 7, path: '950' });
    read.getCommentThread.mockResolvedValue(null);
    const input = { commentId: 100, entityType: 'model', entityId: 7, sort: 'Oldest' } as never;
    await expect(getCommentThreadHandler({ ctx: ctxFor(), input })).rejects.toThrow();
    expect(read.resolveModelPageCommentId.mock.calls[0].slice(1)).toEqual([7, 100]);
    expect(read.getCommentEntity.mock.calls[0][1]).toBe(950);
    expect(read.getCommentThread.mock.calls[0][1]).toBe(950);
  });

  it('answers which comment a model-page link marks, an old v1 id included', async () => {
    read.resolveModelPageCommentId.mockImplementation(async (_db, _modelId, id) =>
      id === 100 ? 950 : id === 101 ? 951 : id
    );
    read.getCommentEntity.mockResolvedValue({ entityType: 'model', entityId: 7, path: '950' });
    read.getCommentThread.mockResolvedValue({
      comment: { id: 950, user: { id: 3, username: 'ann' } },
      replies: { ...page, comments: [] },
    });
    const thread = await getCommentThreadHandler({
      ctx: ctxFor(),
      input: {
        commentId: 100,
        highlight: 101,
        entityType: 'model',
        entityId: 7,
        sort: 'Oldest',
      } as never,
    });
    expect(thread.highlightId).toBe(951);
  });

  it('asks the read for the page’s entity, so another entity’s comment is not found', async () => {
    read.getCommentEntity.mockResolvedValue({ entityType: 'article', entityId: 99, path: '5' });
    read.getCommentThread.mockResolvedValue(null);
    const input = { commentId: 5, entityType: 'article', entityId: 10, sort: 'Oldest' } as never;
    await expect(getCommentThreadHandler({ ctx: ctxFor(), input })).rejects.toThrow(
      'Comment not found'
    );
    // Only a model-page link may carry an old v1 id.
    expect(read.resolveModelPageCommentId).not.toHaveBeenCalled();
    expect(read.getCommentThread.mock.calls[0][3]).toMatchObject({
      entity: { entityType: 'article', entityId: 10 },
    });
  });
});

describe('each comment carries its author as the cache has them', () => {
  const withAuthor = { ...page, comments: [{ id: 5, user: { id: 3, username: 'ann' } }] };
  beforeEach(() =>
    authors.mockResolvedValue((id: number) =>
      id === 3 ? { profilePicture: { id: 9 }, showcaseHat: { id: 4 } } : {}
    )
  );

  it.each([
    ['a section', () => getCommentSectionHandler({ ctx: ctxFor({ id: 2 }), input: sectionInput })],
    [
      'replies',
      () => {
        read.getCommentEntity.mockResolvedValue({ entityType: 'article', entityId: 10, path: '5' });
        return getCommentRepliesHandler({
          ctx: ctxFor({ id: 2 }),
          input: { parentId: 5, sort: 'Oldest' } as never,
        });
      },
    ],
    [
      'a thread',
      async () => {
        read.getCommentEntity.mockResolvedValue({ entityType: 'article', entityId: 10, path: '5' });
        read.getCommentThread.mockResolvedValue({
          comment: withAuthor.comments[0],
          replies: { ...page, comments: [] },
        });
        const thread = await getCommentThreadHandler({
          ctx: ctxFor({ id: 2 }),
          input: { commentId: 5, entityType: 'article', entityId: 10, sort: 'Oldest' } as never,
        });
        // The deep-linked comment heads the thread, so its author is hydrated too.
        return { comments: [thread.comment] };
      },
    ],
  ])('on %s: picture, cosmetics and showcase hat', async (_, call) => {
    read.getCommentSection.mockResolvedValue(withAuthor);
    read.getCommentReplies.mockResolvedValue(withAuthor);
    const result = (await call()) as { comments: { user: unknown }[] };
    expect(authors).toHaveBeenCalledWith([3], { showcaseHat: true });
    expect(result.comments[0].user).toEqual({
      id: 3,
      username: 'ann',
      profilePicture: { id: 9 },
      showcaseHat: { id: 4 },
    });
  });
});

describe('the section controls answer only where the section is visible', () => {
  const input = { entityType: 'bounty', entityId: 7 } as const;
  const member = { user: { id: 2, isModerator: false } } as never;

  it.each([
    ['lock state', () => getSectionLockHandler({ ctx: member, input })],
    ['mute state', () => getSectionMutedHandler({ ctx: member, input })],
    ['mute toggle', () => toggleSectionMuteHandler({ ctx: member, input })],
  ])('%s is not found on a hidden section', async (_, call) => {
    gate.mockRejectedValueOnce(Object.assign(new Error('hidden'), { code: 'NOT_FOUND' }));
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(gate).toHaveBeenCalledWith({ entityType: 'bounty', entityId: 7 }, expect.anything());
    expect(read.getCommentLock).not.toHaveBeenCalled();
    expect(section.getSectionMuted).not.toHaveBeenCalled();
    expect(section.toggleSectionMute).not.toHaveBeenCalled();
  });

  it('answers for a visible one, as the caller (control)', async () => {
    await toggleSectionMuteHandler({ ctx: member, input });
    expect(section.toggleSectionMute).toHaveBeenCalledWith({ ...input, userId: 2 });
  });

  // A thread mute takes a bare comment id, so it is gated on the stored comment's section.
  it.each([
    ['thread mute state', () => getCommentMutedHandler({ ctx: member, input: { commentId: 5 } })],
    [
      'thread mute toggle',
      () => toggleCommentMuteHandler({ ctx: member, input: { commentId: 5 } }),
    ],
  ])('%s is not found in a hidden section', async (_, call) => {
    gate.mockRejectedValueOnce(Object.assign(new Error('hidden'), { code: 'NOT_FOUND' }));
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(gate).toHaveBeenCalledWith({ entityType: 'bounty', entityId: 7 }, expect.anything());
    expect(section.getCommentMuted).not.toHaveBeenCalled();
    expect(section.toggleCommentMute).not.toHaveBeenCalled();
  });

  it('mutes a thread in a visible section, as the caller (control)', async () => {
    await toggleCommentMuteHandler({ ctx: member, input: { commentId: 5 } });
    // Hands on the row the gate read, so the service does not read it again.
    expect(section.toggleCommentMute).toHaveBeenCalledWith(
      { commentId: 5, userId: 2 },
      { comment: expect.objectContaining({ id: 5, entityType: 'bounty' }) }
    );
    expect(stored).toHaveBeenCalledTimes(1);
  });
});
