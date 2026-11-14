import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FeatureFlags from '~/server/services/feature-flags.service';

// Each surface's entry wires an entity type to its own rule; the rules themselves are tested where
// they live. What is pinned here is the wiring: which rule, with which argument.

const m = vi.hoisted(() => ({
  bountyVisible: vi.fn(async (_: unknown, __: unknown) => undefined),
  crucibleVisible: vi.fn(async (_: unknown, __: unknown) => undefined),
  storylineVisible: vi.fn(async (..._: unknown[]) => ({ tosViolation: false })),
  access: vi.fn(async (_: unknown) => [{ hasAccess: true }]),
  notify: vi.fn(async (_: unknown) => undefined),
  readerLevel: vi.fn((..._: unknown[]) => 3),
  flags: { storylines: true },
}));

vi.mock('~/server/services/bounty-visibility', () => ({ assertBountyVisible: m.bountyVisible }));
vi.mock('~/server/services/crucible.service', () => ({ assertCrucibleVisible: m.crucibleVisible }));
vi.mock('~/server/services/storyline.service', () => ({
  assertStorylineVisible: m.storylineVisible,
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: m.access }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: m.notify }));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => m.flags,
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  BlockedByUsers: { getCached: async () => [{ id: 21 }] },
  BlockedUsers: { getCached: async () => [{ id: 22 }] },
  HiddenUsers: { getCached: async () => [{ id: 23 }] },
}));
vi.mock('~/server/utils/storyline-reader-level', () => ({ storylineReaderLevel: m.readerLevel }));

const { commentSurface } = await import('~/server/services/commentv3/surfaces');

const member = { user: { id: 2, isModerator: false, username: 'ann' } } as never;
const moderator = { user: { id: 9, isModerator: true } } as never;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  m.flags = { storylines: true };
});

describe('visibility', () => {
  it('checks a bounty by its id and an entry by its entry id', async () => {
    await commentSurface('bounty').assertVisible?.(7, member);
    await commentSurface('bountyEntry').assertVisible?.(8, member);
    expect(m.bountyVisible.mock.calls.map(([arg]) => arg)).toEqual([
      { bountyId: 7 },
      { entryId: 8 },
    ]);
  });

  it('checks a crucible and a storyline through their own gates', async () => {
    await commentSurface('crucible').assertVisible?.(5, member);
    expect(m.crucibleVisible).toHaveBeenCalledWith(5, expect.anything());
    await commentSurface('storyline').assertVisible?.(6, member);
    // Held to the level this reader is served at, worked out from their own context.
    expect(m.readerLevel.mock.calls[0][0]).toBe(member);
    expect(m.storylineVisible).toHaveBeenCalledWith(6, expect.anything(), 3);
  });

  it('hands the crucible gate the viewer, the site, and every creator either side blocked', async () => {
    const green = { user: { id: 2, isModerator: false }, features: { isGreen: true } } as never;
    await commentSurface('crucible').assertVisible?.(5, green);
    expect(m.crucibleVisible).toHaveBeenCalledWith(5, {
      viewerId: 2,
      isModerator: false,
      isGreen: true,
      blockedCreatorIds: [21, 22],
    });
    await commentSurface('crucible').assertVisible?.(5, moderator);
    expect(m.crucibleVisible).toHaveBeenLastCalledWith(
      5,
      expect.objectContaining({ isModerator: true, blockedCreatorIds: [] })
    );
  });

  it('hides a storyline thread from a viewer without the storylines feature', async () => {
    m.flags = { storylines: false };
    await expect(commentSurface('storyline').assertVisible?.(6, member)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(m.storylineVisible).not.toHaveBeenCalled();
  });
});

describe('a post', () => {
  const visible = commentSurface('post').assertVisible!;
  const stranger = { user: { id: 3, isModerator: false } } as never;
  const anon = { user: undefined } as never;

  it("is not found for a stranger when the post detail rule doesn't show it them", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00Z'), toFake: ['Date'] });
    try {
      dbMock.dbRead.post.findFirst.mockResolvedValue(null as never);
      // The post detail rule, for each viewer: published and rated, theirs, or a collection they judge.
      const { getPostDetailVisibility } = await import('~/server/services/post-detail-visibility');
      for (const [ctx, user] of [
        [stranger, { id: 3, isModerator: false }],
        [anon, undefined],
      ] as const) {
        dbMock.dbRead.post.findFirst.mockClear();
        await expect(visible(7, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(dbMock.dbRead.post.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 7, ...getPostDetailVisibility(user) } })
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('is readable when the rule finds the post (control)', async () => {
    dbMock.dbRead.post.findFirst.mockResolvedValue({ id: 7 } as never);
    await expect(visible(7, stranger)).resolves.toBeUndefined();
  });
});

describe('a comic chapter', () => {
  const stranger = { user: { id: 2, isModerator: false } } as never;
  const owner = { user: { id: 5, isModerator: false } } as never;
  const clean = { tosViolation: false, needsReview: null, ingestion: 'Scanned' };
  const chapter = (
    over: { status?: string; panels?: unknown[]; project?: Record<string, unknown> } = {}
  ) =>
    dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
      status: over.status ?? 'Published',
      panels: over.panels ?? [{ image: clean }],
      project: {
        userId: 5,
        status: 'Active',
        tosViolation: false,
        publishedAt: new Date(),
        nsfwLevel: 1,
        user: { bannedAt: null },
        ...over.project,
      },
    } as never);
  const visible = (ctx: never) => commentSurface('comicChapter').assertVisible?.(12, ctx);

  it('shows the comments of a published chapter of a live project (control)', async () => {
    chapter();
    await expect(visible(stranger)).resolves.toBeUndefined();
    // Counts only the panels the reader serves; an unready panel must not make a chapter visible.
    expect(dbMock.dbRead.comicChapter.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          panels: {
            where: { status: 'Ready', imageUrl: { not: null } },
            select: {
              image: { select: { tosViolation: true, needsReview: true, ingestion: true } },
            },
          },
          project: {
            select: expect.objectContaining({
              userId: true,
              status: true,
              tosViolation: true,
              publishedAt: true,
              nsfwLevel: true,
              user: { select: { bannedAt: true } },
            }),
          },
        }),
      })
    );
  });

  it.each([
    ['a draft chapter', { status: 'Draft' }],
    ['a project taken down for ToS', { project: { tosViolation: true } }],
    ['a banned author', { project: { user: { bannedAt: new Date() } } }],
    ['a panel removed for ToS', { panels: [{ image: { ...clean, tosViolation: true } }] }],
    ['a panel in review', { panels: [{ image: { ...clean, needsReview: 'poi' } }] }],
    ['a panel not yet scanned', { panels: [{ image: { ...clean, ingestion: 'Pending' } }] }],
    ['a panel with no image yet', { panels: [{ image: null }] }],
    ['a creator who blocked the reader', { project: { userId: 21 } }],
    ['a creator the reader blocked', { project: { userId: 22 } }],
    ['a creator the reader hid', { project: { userId: 23 } }],
    ['a project never published', { project: { publishedAt: null } }],
  ])('hides %s from a reader, as the reader does', async (_, over) => {
    chapter(over);
    await expect(visible(stranger)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('hides a mature comic on the green domain only, from everyone as the reader does', async () => {
    const green = { user: { id: 2, isModerator: false }, features: { isGreen: true } } as never;
    const greenOwner = {
      user: { id: 5, isModerator: false },
      features: { isGreen: true },
    } as never;
    chapter({ project: { nsfwLevel: 4 } });
    await expect(visible(green)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(visible(greenOwner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(visible(stranger)).resolves.toBeUndefined();
    chapter();
    await expect(visible(green)).resolves.toBeUndefined();
  });

  it('shows a draft with a panel in review to its owner and to a moderator', async () => {
    chapter({ status: 'Draft', panels: [{ image: { ...clean, needsReview: 'poi' } }] });
    await expect(visible(owner)).resolves.toBeUndefined();
    await expect(visible(moderator)).resolves.toBeUndefined();
  });

  // The reader hides these from everyone, the owner and moderators included.
  it.each([
    ['a deleted project', { project: { status: 'Deleted' } }],
    ['a chapter with no ready panels', { panels: [] }],
  ])('hides %s even from its owner and a moderator', async (_, over) => {
    chapter(over);
    await expect(visible(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(visible(moderator)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is not found when the chapter does not exist', async () => {
    dbMock.dbRead.comicChapter.findUnique.mockResolvedValue(null as never);
    await expect(visible(stranger)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('writes', () => {
  it.each([
    ['article', 'Article'],
    ['post', 'Post'],
  ])('a %s comment needs access to the %s', async (entityType, gated) => {
    m.access.mockResolvedValueOnce([{ hasAccess: false }]);
    await expect(commentSurface(entityType).assertWritable?.(4, member)).rejects.toThrow();
    expect(m.access).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: gated, entityIds: [4] })
    );
  });

  it('refuses a member on a storyline taken down for ToS; a moderator may', async () => {
    dbMock.dbRead.storyline.findUnique.mockResolvedValue({ tosViolation: true } as never);
    await expect(commentSurface('storyline').assertWritable?.(6, member)).rejects.toThrow(
      'taken down'
    );
    await commentSurface('storyline').assertWritable?.(6, moderator);
    dbMock.dbRead.storyline.findUnique.mockResolvedValue({ tosViolation: false } as never);
    await commentSurface('storyline').assertWritable?.(6, member);
  });
});

describe('a new comic chapter comment', () => {
  const comment = (over: Record<string, unknown> = {}) =>
    ({ id: 300, entityId: 12, userId: 2, parentId: null, ...over } as never);
  const chapter = (ownerId: number) =>
    dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
      projectId: 3,
      position: 4,
      name: 'One',
      project: { userId: ownerId, name: 'Saga' },
    } as never);
  const created = async (c: never) => {
    commentSurface('comicChapter').onCreated?.(c, member);
    await vi.waitFor(() => expect(dbMock.dbRead.comicChapter.findUnique).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
  };

  it("tells the project owner, keyed to the chapter and deduped with the thread's", async () => {
    chapter(5);
    await created(comment());
    expect(m.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'new-comic-comment',
        userId: 5,
        key: 'new-comic-comment:3:4:300',
        dedupeKey: 'comment:v2:300',
      })
    );
  });

  it('tells nobody about the owner’s own comment', async () => {
    chapter(2);
    await created(comment());
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('tells nobody about a reply', async () => {
    chapter(5);
    commentSurface('comicChapter').onCreated?.(comment({ parentId: 1 }), member);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.notify).not.toHaveBeenCalled();
  });
});

describe('a new storyline text comment', () => {
  const comment = (over: Record<string, unknown> = {}) =>
    ({ id: 310, entityId: 50, userId: 2, parentId: null, ...over } as never);
  const text = (ownerId: number) =>
    dbMock.dbRead.$queryRawUnsafe.mockResolvedValue([
      { postId: 31, userId: ownerId, title: 'Chapter one', anchorImageId: 10 },
    ] as never);
  const created = async (c: never) => {
    commentSurface('postText').onCreated?.(c, member);
    await vi.waitFor(() => expect(dbMock.dbRead.$queryRawUnsafe).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
  };

  it("tells the post's owner as a post comment, linked to the text slide, deduped with the thread's", async () => {
    text(5);
    await created(comment());
    expect(m.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'new-post-comment', userId: 5, dedupeKey: 'comment:v2:310' })
    );
    const { commentNotifications } = await import('~/server/notifications/comment.notifications');
    const { details } = m.notify.mock.calls[0][0] as unknown as { details: never };
    // Names the post, not the text, and opens the slide.
    expect(commentNotifications['new-post-comment'].prepareMessage({ details } as never)).toEqual({
      message: 'ann commented on your post: "Chapter one"',
      url: '/images/10?text=50&highlight=310',
    });
  });

  it('tells nobody about the owner’s own comment, or a reply', async () => {
    text(2);
    await created(comment());
    text(5);
    commentSurface('postText').onCreated?.(comment({ parentId: 1 }), member);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.notify).not.toHaveBeenCalled();
  });
});

describe('a model', () => {
  const model = (over: Record<string, unknown> = {}) => ({
    status: 'Published',
    userId: 5,
    locked: false,
    modelVersions: [{ id: 70 }, { id: 71 }],
    ...over,
  });
  const visible = (ctx: unknown) => commentSurface('model').assertVisible!(3, ctx as never);
  const writable = (ctx: unknown) => commentSurface('model').assertOpen!(3, ctx as never);
  const owner = { user: { id: 5, isModerator: false } };

  it('shows a published model to anyone, and an unpublished one to its owner and moderators', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(model() as never);
    await expect(visible({ user: undefined })).resolves.toBeUndefined();
    dbMock.dbRead.model.findUnique.mockResolvedValue(model({ status: 'Draft' }) as never);
    await expect(visible(member)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(visible(owner)).resolves.toBeUndefined();
    await expect(visible(moderator)).resolves.toBeUndefined();
  });

  it('hides a poi model from everyone but its owner and moderators', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(model({ poi: true }) as never);
    await expect(visible(member)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(visible({ user: undefined })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(visible(owner)).resolves.toBeUndefined();
    await expect(visible(moderator)).resolves.toBeUndefined();
  });

  it('keeps a locked model readable', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(model({ locked: true }) as never);
    await expect(visible(member)).resolves.toBeUndefined();
  });

  it('takes comments on an unlocked model with a published version (control)', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(model() as never);
    await expect(writable(member)).resolves.toBeUndefined();
    // Two published versions: the older one is open, so access is not checked.
    expect(m.access).not.toHaveBeenCalled();
    // The mock answers whatever is asked, so the question itself is the rule: published versions,
    // the first two in order, which is how a second one is known to exist.
    expect(dbMock.dbRead.model.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: {
        locked: true,
        meta: true,
        modelVersions: {
          take: 2,
          select: { id: true },
          where: { status: 'Published' },
          orderBy: { index: 'asc' },
        },
      },
    });
  });

  it.each([
    ['a locked model', { locked: true }],
    ['a model with its comments locked', { meta: { commentsLocked: true } }],
  ])('refuses a member on %s; a moderator may', async (_, over) => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(model(over) as never);
    await expect(writable(member)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(writable(moderator)).resolves.toBeUndefined();
  });

  it('refuses a model with no published version', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(model({ modelVersions: [] }) as never);
    await expect(writable(moderator)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets a writer with access to a lone published version through, a moderator included', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(
      model({ modelVersions: [{ id: 70 }] }) as never
    );
    await expect(writable(member)).resolves.toBeUndefined();
    await expect(writable(moderator)).resolves.toBeUndefined();
    expect(m.access).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityIds: [70], userId: 9, isModerator: true })
    );
  });

  it('checks access to a lone published version, for early access', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(
      model({ modelVersions: [{ id: 70 }] }) as never
    );
    m.access.mockResolvedValueOnce([{ hasAccess: false }]);
    await expect(writable(member)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(m.access).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'ModelVersion',
        entityIds: [70],
        userId: 2,
        isModerator: false,
      })
    );
  });
});
