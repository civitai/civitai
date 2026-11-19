import { describe, expect, it, vi } from 'vitest';
import { tombstoneChaptersForPlacements } from '~/server/services/storyline-chapter-removal.service';

const txWith = (count: number) => {
  const updateMany = vi.fn(async () => ({ count }));
  // No chapters to walk up from: the walk itself is storyline-insert-chapter.sql.behavior.test.ts.
  const findMany = vi.fn(async () => []);
  return { tx: { storylineChapter: { updateMany, findMany } } as never, updateMany };
};

describe('tombstoneChaptersForPlacements', () => {
  it('marks the chapters those placements added, once, on the client it is handed', async () => {
    const { tx, updateMany } = txWith(2);
    await expect(tombstoneChaptersForPlacements({ placementIds: [7, 8, 9] }, tx)).resolves.toBe(2);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      // A chapter already marked keeps its first removedAt.
      where: { placementId: { in: [7, 8, 9] }, removedAt: null },
      data: { removedAt: expect.any(Date) },
    });
  });

  it('asks nothing for no placements', async () => {
    const { tx, updateMany } = txWith(5);
    await expect(tombstoneChaptersForPlacements({ placementIds: [] }, tx)).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
