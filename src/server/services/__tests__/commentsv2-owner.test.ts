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
  'comicChapter',
] as const;

const lookup = (table: (typeof OWNER_TABLES)[number]) => dbMock.dbRead[table].findUnique;
const anyLookupCalled = () => OWNER_TABLES.some((t) => lookup(t).mock.calls.length > 0);

import { getThreadEntityOwnerId, isViewerContentOwner } from '../commentsv2.service';

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
