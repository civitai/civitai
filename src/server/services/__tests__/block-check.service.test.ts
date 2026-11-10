import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * User-blocking enforcement on write/interaction paths.
 *
 * Blocking used to be enforced read-side only (a blocked viewer 404s on the
 * entity page), so a blocked user could still comment / reply / react / review
 * the creator's content via direct tRPC/API calls. `throwIfBlockedByEntityOwner`
 * closes that gap by resolving the content owner and throwing NotFound (mirroring
 * the read handlers) when the acting user is blocked by that owner.
 */

const { amIBlockedByUser } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));

vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser }));

import {
  getBlockCheckOwnerIds,
  throwIfBlockedByEntityOwner,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDb = dbMock.dbWrite;

const OWNER = 100;
const VIEWER = 7;

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
});

describe('getBlockCheckOwnerIds — owner resolution per entity type', () => {
  it('resolves the image owner', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'image', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the post owner', async () => {
    mockDb.post.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'post', entityId: 1 })).toEqual([OWNER]);
  });

  it.each([
    ['article', 'article'],
    ['bounty', 'bounty'],
    ['bountyEntry', 'bountyEntry'],
  ] as const)('resolves the %s owner', async (entityType, table) => {
    mockDb[table].findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType, entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the model owner', async () => {
    mockDb.model.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the resourceReview owner (review + resourceReview aliases)', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'review', entityId: 1 })).toEqual([OWNER]);
    expect(await getBlockCheckOwnerIds({ entityType: 'resourceReview', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  it('resolves the model3d owner', async () => {
    mockDb.model3D.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model3d', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the model3dReview owner', async () => {
    mockDb.model3DReview.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model3dReview', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  it('resolves the comicChapter owner via its project', async () => {
    mockDb.comicChapter.findUnique.mockResolvedValueOnce({ project: { userId: OWNER } });
    expect(await getBlockCheckOwnerIds({ entityType: 'comicChapter', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  it('resolves the appListing owner by its integer surrogate, not its ULID', async () => {
    mockDb.appListing.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'appListing', entityId: 42 })).toEqual([
      OWNER,
    ]);
    expect(mockDb.appListing.findUnique).toHaveBeenCalledWith({
      where: { serialId: 42 },
      select: { userId: true },
    });
  });

  it('resolves the crucible creator', async () => {
    mockDb.crucible.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'crucible', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the storyline owner', async () => {
    mockDb.storyline.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'storyline', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the challenge creator', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ createdById: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'challenge', entityId: 1 })).toEqual([OWNER]);
  });

  it('returns [] for a system challenge with no creator', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ createdById: null });
    expect(await getBlockCheckOwnerIds({ entityType: 'challenge', entityId: 1 })).toEqual([]);
  });

  it('returns [] when the entity does not exist', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce(null);
    expect(await getBlockCheckOwnerIds({ entityType: 'image', entityId: 1 })).toEqual([]);
  });
});

describe('throwIfBlockedByEntityOwner — enforcement', () => {
  it('throws NotFound when the acting user is blocked by the content owner', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'image', entityId: 1 })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: VIEWER,
      targetUserId: OWNER,
      confirmOnPrimary: true,
    });
  });

  it('rejects a blocked user creating a model3d comment', async () => {
    mockDb.model3D.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'model3d', entityId: 1 })
    ).rejects.toThrow();
  });

  it('rejects a blocked user creating a comicChapter comment', async () => {
    mockDb.comicChapter.findUnique.mockResolvedValueOnce({ project: { userId: OWNER } });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'comicChapter', entityId: 1 })
    ).rejects.toThrow();
  });

  it('does not throw when the acting user is NOT blocked', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValue(false);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'image', entityId: 1 })
    ).resolves.toBeUndefined();
  });

  it('never blocks the owner acting on their own content (owner === viewer)', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    await throwIfBlockedByEntityOwner({ userId: OWNER, entityType: 'image', entityId: 1 });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });

  it('exempts moderators even when blocked', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValue(true);
    await expect(
      throwIfBlockedByEntityOwner({
        userId: VIEWER,
        entityType: 'image',
        entityId: 1,
        isModerator: true,
      })
    ).resolves.toBeUndefined();
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });
});

describe('throwIfBlockedByOwners — reply helper', () => {
  it('throws if blocked by ANY of the supplied owners (e.g. parent comment author)', async () => {
    amIBlockedByUser.mockImplementation(async ({ targetUserId }: { targetUserId: number }) => {
      return targetUserId === 55; // blocked by the parent comment author only
    });
    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [OWNER, 55] })
    ).rejects.toThrow();
  });

  it('skips null/undefined owner ids and passes when none block', async () => {
    amIBlockedByUser.mockResolvedValue(false);
    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [OWNER, null, undefined] })
    ).resolves.toBeUndefined();
  });
});

/**
 * A comment's block targets come from its stored CommentV3 row: its author and the owner of the
 * section it is on. The request names only the comment id, so nothing a client sends picks them.
 */
describe('comment block targets — from the CommentV3 row', () => {
  const AUTHOR = 21;
  type Row = { userId: number; entityType: string; entityId: number; deletedAt: Date | null };
  let rows: Record<number, Row> = {};

  beforeEach(() => {
    for (const fn of [
      mockDb.$queryRaw,
      mockDb.article.findUnique,
      dbMock.dbRead.article.findUnique,
    ])
      fn.mockReset();
    rows = {};
    // Honours the query's own id and live-row filter, so a query that drops either reads wrong rows.
    mockDb.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = strings.join('?');
      if (!sql.includes('FROM "CommentV3" c')) return [];
      const row = rows[values[0] as number];
      if (!row || (row.deletedAt && sql.includes('c."deletedAt" IS NULL'))) return [];
      const { deletedAt: _deletedAt, ...rest } = row;
      return [rest];
    }) as never);
    dbMock.dbRead.article.findUnique.mockResolvedValue(null as never);
    mockDb.article.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
      where.id === 9 ? { userId: OWNER } : null) as never);
  });

  it('resolves the author and the owner of the section the comment is on', async () => {
    rows[5] = { userId: AUTHOR, entityType: 'article', entityId: 9, deletedAt: null };
    expect(await getBlockCheckOwnerIds({ entityType: 'comment', entityId: 5 })).toEqual([
      AUTHOR,
      OWNER,
    ]);
  });

  it('names the section owner once when they wrote the comment', async () => {
    rows[5] = { userId: OWNER, entityType: 'article', entityId: 9, deletedAt: null };
    expect(await getBlockCheckOwnerIds({ entityType: 'comment', entityId: 5 })).toEqual([OWNER]);
  });

  it('refuses a reaction when only the section owner blocks the reactor', async () => {
    rows[5] = { userId: AUTHOR, entityType: 'article', entityId: 9, deletedAt: null };
    amIBlockedByUser.mockImplementation(
      async (args) => (args as { targetUserId: number }).targetUserId === OWNER
    );
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'comment', entityId: 5 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: VIEWER,
      targetUserId: OWNER,
      confirmOnPrimary: true,
    });
  });

  it('refuses a reaction when the comment author blocks the reactor', async () => {
    rows[5] = { userId: AUTHOR, entityType: 'article', entityId: 9, deletedAt: null };
    amIBlockedByUser.mockImplementation(
      async (args) => (args as { targetUserId: number }).targetUserId === AUTHOR
    );
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'comment', entityId: 5 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is not found for a deleted comment', async () => {
    rows[5] = { userId: AUTHOR, entityType: 'article', entityId: 9, deletedAt: new Date() };
    await expect(
      getBlockCheckOwnerIds({ entityType: 'comment', entityId: 5 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * Every target here exists on the primary and not yet on the replica, as in the moments after it
 * was written. The check must still find its owner.
 */
describe('block targets resolve from the primary, where the guarded write lands', () => {
  const COMMENT_AUTHOR = 55;
  const COMMENT = 10;
  const MISSING = 12;
  const IMAGE = 1;

  beforeEach(() => {
    const replica = dbMock.dbRead;
    for (const fn of [
      mockDb.$queryRaw,
      mockDb.image.findUnique,
      mockDb.post.findUnique,
      mockDb.article.findUnique,
      replica.$queryRaw,
      replica.image.findUnique,
      replica.post.findUnique,
      replica.article.findUnique,
    ])
      fn.mockReset();
    replica.$queryRaw.mockResolvedValue([] as never);
    for (const table of ['image', 'post', 'article'] as const)
      replica[table].findUnique.mockResolvedValue(null as never);

    mockDb.$queryRaw.mockImplementation((async (_s: TemplateStringsArray, id: unknown) =>
      id === COMMENT
        ? [{ userId: COMMENT_AUTHOR, entityType: 'image', entityId: IMAGE }]
        : []) as never);
    mockDb.image.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
      where.id === IMAGE ? { userId: OWNER } : null) as never);
  });

  it('a reaction on a comment the replica has not seen yet checks its author and section owner', async () => {
    expect(await getBlockCheckOwnerIds({ entityType: 'comment', entityId: COMMENT })).toEqual([
      COMMENT_AUTHOR,
      OWNER,
    ]);
  });

  it('a write on content the replica has not seen yet is refused when its owner blocks', async () => {
    amIBlockedByUser.mockImplementation(
      async (args) => (args as { targetUserId: number }).targetUserId === OWNER
    );
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'image', entityId: IMAGE })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['post', 'article'] as const)(
    'a %s the replica has not seen yet resolves its owner from the primary',
    async (entityType) => {
      mockDb[entityType].findUnique.mockResolvedValue({ userId: OWNER } as never);
      expect(await getBlockCheckOwnerIds({ entityType, entityId: IMAGE })).toEqual([OWNER]);
    }
  );

  // Reactions on these are the highest-volume writes this guards, and the replica answers nearly all
  // of them. Only a miss may cost a primary read: reading the primary first puts every one on it.
  it.each(['image', 'post', 'article'] as const)(
    'a %s the replica already has costs no primary read',
    async (entityType) => {
      dbMock.dbRead[entityType].findUnique.mockResolvedValue({ userId: OWNER } as never);
      expect(await getBlockCheckOwnerIds({ entityType, entityId: IMAGE })).toEqual([OWNER]);
      expect(mockDb[entityType].findUnique).not.toHaveBeenCalled();
    }
  );

  // A reaction on a comment that does not exist is refused rather than reaching the write.
  it('refuses a reaction on a comment the primary does not have', async () => {
    await expect(
      getBlockCheckOwnerIds({ entityType: 'comment', entityId: MISSING })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
