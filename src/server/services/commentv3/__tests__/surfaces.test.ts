import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Each surface's entry wires an entity type to its own rule; the rules themselves are tested where
// they live. What is pinned here is the wiring: which rule, with which argument.

const m = vi.hoisted(() => ({
  bountyVisible: vi.fn(async (_: unknown, __: unknown) => undefined),
  crucibleVisible: vi.fn(async (_: unknown, __: unknown) => undefined),
  storylineVisible: vi.fn(async (..._: unknown[]) => ({ tosViolation: false })),
  access: vi.fn(async (_: unknown) => [{ hasAccess: true }]),
  notify: vi.fn(async (_: unknown) => undefined),
}));

vi.mock('~/server/services/bounty-visibility', () => ({ assertBountyVisible: m.bountyVisible }));
vi.mock('~/server/services/crucible.service', () => ({ assertCrucibleVisible: m.crucibleVisible }));
vi.mock('~/server/services/storyline.service', () => ({
  assertStorylineVisible: m.storylineVisible,
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: m.access }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: m.notify }));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: () => ({ storylines: true }),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  BlockedByUsers: { getCached: async () => [] },
  BlockedUsers: { getCached: async () => [] },
}));
vi.mock('~/server/utils/storyline-reader-level', () => ({ storylineReaderLevel: () => 1 }));

const { commentSurface } = await import('~/server/services/commentv3/surfaces');

const member = { user: { id: 2, isModerator: false, username: 'ann' } } as never;
const moderator = { user: { id: 9, isModerator: true } } as never;

beforeEach(() => vi.clearAllMocks());

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
    expect(m.storylineVisible).toHaveBeenCalledWith(6, expect.anything(), 1);
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
