import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// One spy used to serve all twelve tables, so a case could not tell which one the service read.
// Each entity type now arms its own table, which is what the assertions were always about.
const OWNER_TABLES = [
  'image',
  'post',
  'model',
  'article',
  'bounty',
  'bountyEntry',
  'resourceReview',
  'commentV2',
  'question',
  'answer',
  'challenge',
  'crucible',
  'comicChapter',
] as const;

const lookup = (table: (typeof OWNER_TABLES)[number]) => dbMock.dbRead[table].findUnique;
const anyLookupCalled = () => OWNER_TABLES.some((t) => lookup(t).mock.calls.length > 0);

import {
  canToggleThreadLock,
  getThreadEntityOwnerId,
  isViewerContentOwner,
} from '../commentsv2.service';

describe('getThreadEntityOwnerId', () => {
  beforeEach(() => OWNER_TABLES.forEach((t) => lookup(t).mockReset()));

  it('resolves the owner via userId for standard entity types', async () => {
    lookup('image').mockResolvedValueOnce({ userId: 99 });
    await expect(getThreadEntityOwnerId({ entityType: 'image', entityId: 1 })).resolves.toBe(99);
  });

  it('resolves the challenge owner via createdById', async () => {
    lookup('challenge').mockResolvedValueOnce({ createdById: 7 });
    await expect(getThreadEntityOwnerId({ entityType: 'challenge', entityId: 1 })).resolves.toBe(7);
  });

  it('resolves the crucible creator via userId', async () => {
    lookup('crucible').mockResolvedValueOnce({ userId: 31 });
    await expect(getThreadEntityOwnerId({ entityType: 'crucible', entityId: 5 })).resolves.toBe(31);
  });

  it('resolves the comicChapter owner via the parent project', async () => {
    lookup('comicChapter').mockResolvedValueOnce({ project: { userId: 12 } });
    await expect(getThreadEntityOwnerId({ entityType: 'comicChapter', entityId: 1 })).resolves.toBe(
      12
    );
  });

  it('returns null for entity types we cannot cheaply resolve', async () => {
    await expect(
      getThreadEntityOwnerId({ entityType: 'model3d', entityId: 1 })
    ).resolves.toBeNull();
    expect(anyLookupCalled()).toBe(false);
  });

  it('returns null when the entity is missing', async () => {
    lookup('post').mockResolvedValueOnce(null);
    await expect(getThreadEntityOwnerId({ entityType: 'post', entityId: 1 })).resolves.toBeNull();
  });
});

describe('isViewerContentOwner', () => {
  beforeEach(() => OWNER_TABLES.forEach((t) => lookup(t).mockReset()));

  it('is true when the viewer owns the content a blocker engaged with', async () => {
    // Blocker 42 downvoted/commented then blocked the owner (id 5).
    lookup('image').mockResolvedValueOnce({ userId: 5 });
    await expect(
      isViewerContentOwner({
        entityType: 'image',
        entityId: 1,
        userId: 5,
        blockedByUsers: [42],
      })
    ).resolves.toBe(true);
  });

  it('is false for a non-owner viewer (keeps blocker excluded)', async () => {
    lookup('image').mockResolvedValueOnce({ userId: 5 });
    await expect(
      isViewerContentOwner({
        entityType: 'image',
        entityId: 1,
        userId: 999,
        blockedByUsers: [42],
      })
    ).resolves.toBe(false);
  });

  it('skips the lookup entirely when the viewer has no blocked-by list', async () => {
    await expect(
      isViewerContentOwner({ entityType: 'image', entityId: 1, userId: 5, blockedByUsers: [] })
    ).resolves.toBe(false);
    expect(anyLookupCalled()).toBe(false);
  });

  it('skips the lookup for an anonymous viewer', async () => {
    await expect(
      isViewerContentOwner({
        entityType: 'image',
        entityId: 1,
        userId: undefined,
        blockedByUsers: [42],
      })
    ).resolves.toBe(false);
    expect(anyLookupCalled()).toBe(false);
  });
});

describe('canToggleThreadLock', () => {
  beforeEach(() => OWNER_TABLES.forEach((t) => lookup(t).mockReset()));

  const lockAs = (
    userId: number,
    entityType: Parameters<typeof canToggleThreadLock>[0]['entityType']
  ) => canToggleThreadLock({ userId, isModerator: false, entityType, entityId: 5 });

  it('lets a moderator lock any thread without resolving an owner', async () => {
    await expect(
      canToggleThreadLock({ userId: 1, isModerator: true, entityType: 'article', entityId: 5 })
    ).resolves.toBe(true);
    expect(anyLookupCalled()).toBe(false);
  });

  it("lets a crucible's creator lock its thread", async () => {
    lookup('crucible').mockResolvedValueOnce({ userId: 31 });
    await expect(lockAs(31, 'crucible')).resolves.toBe(true);
  });

  it('refuses someone who is not the crucible creator', async () => {
    lookup('crucible').mockResolvedValueOnce({ userId: 31 });
    await expect(lockAs(32, 'crucible')).resolves.toBe(false);
  });

  it('refuses when the crucible does not exist', async () => {
    lookup('crucible').mockResolvedValueOnce(null);
    await expect(lockAs(31, 'crucible')).resolves.toBe(false);
  });

  it.each(['article', 'challenge', 'post', 'image', 'model', 'bounty'] as const)(
    'still refuses the owner of a %s: only crucibles open the lock to their owner',
    async (entityType) => {
      lookup('article').mockResolvedValue({ userId: 31 });
      lookup('challenge').mockResolvedValue({ createdById: 31 });
      lookup('post').mockResolvedValue({ userId: 31 });
      lookup('image').mockResolvedValue({ userId: 31 });
      lookup('bounty').mockResolvedValue({ userId: 31 });
      await expect(lockAs(31, entityType)).resolves.toBe(false);
      expect(anyLookupCalled()).toBe(false);
    }
  );
});
