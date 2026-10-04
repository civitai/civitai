import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async () => 0),
}));

const { getUserCrucibleStats } = await import('~/server/services/crucible.service');

const USER_ID = 11;
const prizePositions = { '1': 50, '2': 30, '3': 20 };
const entry = (id: number, crucibleId: number, position: number | null) => ({
  id,
  crucibleId,
  position,
  crucible: { prizePositions },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getUserCrucibleStats — win rate', () => {
  it('counts a crucible won when the creator took a prize from below the prize positions', async () => {
    // Crucible 1: another creator holds 1st-3rd, so 4th place takes 2nd prize.
    // Crucible 2: three creators finish ahead, so 4th place takes nothing.
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(4, 1, 4), entry(9, 2, 4)]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      { crucibleId: 1, entryId: 1, userId: 10, position: 1 },
      { crucibleId: 1, entryId: 4, userId: USER_ID, position: 4 },
      { crucibleId: 2, entryId: 6, userId: 20, position: 1 },
      { crucibleId: 2, entryId: 7, userId: 21, position: 2 },
      { crucibleId: 2, entryId: 8, userId: 22, position: 3 },
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toMatchObject({ totalCrucibles: 2, bestPlacement: 4, winRate: 50 });
  });

  it('asks nothing about prizes when the creator never placed', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(4, 1, null)]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toMatchObject({ totalCrucibles: 1, bestPlacement: null, winRate: 0 });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});
