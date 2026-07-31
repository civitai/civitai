import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `remove-blocked-images` keys purely off `JobQueue` and `Image.updatedAt` — it carries no owner
 * and no `deletedAt` predicate. So a grace deletion that a moderator reverses on day 3 still
 * destroys every image row and S3 object on day 7 unless `restoreUser` disarms it. These tests
 * hold that wiring, and the ordering it depends on, in place.
 */
const { mockDbWrite, mockDisarm, mockUnblock, mockCacheRefresh, mockQueueUpdate } = vi.hoisted(
  () => ({
    mockDbWrite: {
      user: { findFirst: vi.fn(), update: vi.fn() },
      model: { findMany: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    },
    mockDisarm: vi.fn(() => 'disarm-statement'),
    mockUnblock: vi.fn(async () => ({ unblocked: 3, stillBlocked: 1 })),
    mockCacheRefresh: vi.fn(async () => undefined),
    mockQueueUpdate: vi.fn(async () => undefined),
  })
);

vi.mock('~/server/db/client', () => ({ dbRead: mockDbWrite, dbWrite: mockDbWrite }));
vi.mock('~/server/services/account-deletion-images', () => ({
  disarmAccountDeletionImagePurge: mockDisarm,
  unblockAccountDeletionImages: mockUnblock,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, userBasicCache: { refresh: mockCacheRefresh } };
});
vi.mock('~/server/search-index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, usersSearchIndex: { queueUpdate: mockQueueUpdate } };
});

import { restoreUser } from '~/server/services/user.service';

const USER_ID = 7;

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.user.findFirst.mockImplementation(async ({ where }: { where: { id?: number } }) =>
    where.id === USER_ID
      ? { id: USER_ID, deletedAt: new Date('2026-07-28T00:00:00Z'), meta: {} }
      : null
  );
  mockDbWrite.user.update.mockResolvedValue({ id: USER_ID });
  mockDisarm.mockReturnValue('disarm-statement');
  mockUnblock.mockResolvedValue({ unblocked: 3, stillBlocked: 1 });
});

const restore = () =>
  restoreUser({ id: USER_ID, username: 'back', email: 'back@x.com', restoreModels: false });

describe('restoreUser image recovery', () => {
  it('disarms the purge queue in the same statement batch that clears deletedAt', async () => {
    await restore();

    expect(mockDisarm).toHaveBeenCalledWith(USER_ID);
    const [batch] = mockDbWrite.$transaction.mock.calls[0];
    // Outside the batch, a crash between the two leaves a live account counting down to losing
    // every image it owns.
    expect(batch).toContain('disarm-statement');
    expect(batch).toHaveLength(2);
  });

  it('unblocks the images the grace pass hid', async () => {
    const result = await restore();

    expect(mockUnblock).toHaveBeenCalledWith(USER_ID);
    expect(result.imagesRestored).toBe(3);
  });

  it('unblocks only after deletedAt is cleared, so the drain job cannot re-hide them', async () => {
    const order: string[] = [];
    mockDbWrite.$transaction.mockImplementationOnce(async (ops: unknown[]) => {
      order.push('clear-deletedAt');
      return ops;
    });
    mockUnblock.mockImplementationOnce(async () => {
      order.push('unblock');
      return { unblocked: 0, stillBlocked: 0 };
    });

    await restore();

    expect(order).toEqual(['clear-deletedAt', 'unblock']);
  });

  it('clears the recorded removal choice without dropping the rest of meta', async () => {
    mockDbWrite.user.findFirst.mockResolvedValueOnce({
      id: USER_ID,
      deletedAt: new Date('2026-07-28T00:00:00Z'),
      meta: { imageRemoval: 'grace', strikeFlaggedForReview: true },
    });

    await restore();

    // Left set, a later re-delete that omits the field silently inherits the old choice.
    expect(mockDbWrite.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: null,
          meta: { strikeFlaggedForReview: true },
        }),
      })
    );
  });

  it('refuses an account that is not deleted before touching any image state', async () => {
    mockDbWrite.user.findFirst.mockResolvedValueOnce({ id: USER_ID, deletedAt: null, meta: {} });

    await expect(restore()).rejects.toThrow();
    expect(mockDisarm).not.toHaveBeenCalled();
    expect(mockUnblock).not.toHaveBeenCalled();
  });
});
