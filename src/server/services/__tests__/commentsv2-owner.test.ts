import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    image: { findUnique },
    post: { findUnique },
    model: { findUnique },
    article: { findUnique },
    bounty: { findUnique },
    bountyEntry: { findUnique },
    resourceReview: { findUnique },
    commentV2: { findUnique },
    question: { findUnique },
    answer: { findUnique },
    challenge: { findUnique },
    comicChapter: { findUnique },
  },
  dbWrite: {},
}));

import { getThreadEntityOwnerId, isViewerContentOwner } from '../commentsv2.service';

describe('getThreadEntityOwnerId', () => {
  beforeEach(() => findUnique.mockReset());

  it('resolves the owner via userId for standard entity types', async () => {
    findUnique.mockResolvedValueOnce({ userId: 99 });
    await expect(getThreadEntityOwnerId({ entityType: 'image', entityId: 1 })).resolves.toBe(99);
  });

  it('resolves the challenge owner via createdById', async () => {
    findUnique.mockResolvedValueOnce({ createdById: 7 });
    await expect(getThreadEntityOwnerId({ entityType: 'challenge', entityId: 1 })).resolves.toBe(7);
  });

  it('resolves the comicChapter owner via the parent project', async () => {
    findUnique.mockResolvedValueOnce({ project: { userId: 12 } });
    await expect(getThreadEntityOwnerId({ entityType: 'comicChapter', entityId: 1 })).resolves.toBe(
      12
    );
  });

  it('returns null for entity types we cannot cheaply resolve', async () => {
    await expect(
      getThreadEntityOwnerId({ entityType: 'model3d', entityId: 1 })
    ).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the entity is missing', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(getThreadEntityOwnerId({ entityType: 'post', entityId: 1 })).resolves.toBeNull();
  });
});

describe('isViewerContentOwner', () => {
  beforeEach(() => findUnique.mockReset());

  it('is true when the viewer owns the content a blocker engaged with', async () => {
    // Blocker 42 downvoted/commented then blocked the owner (id 5).
    findUnique.mockResolvedValueOnce({ userId: 5 });
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
    findUnique.mockResolvedValueOnce({ userId: 5 });
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
    expect(findUnique).not.toHaveBeenCalled();
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
    expect(findUnique).not.toHaveBeenCalled();
  });
});
