import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const groupBy = dbMock.dbRead.crucibleEntry.groupBy;

const { getCrucibleDetail, getPaidEntryCounts, getUserActiveCrucibles, withPaidEntryCount } =
  await import('~/server/services/crucible.service');

beforeEach(() => {
  vi.clearAllMocks();
  groupBy.mockResolvedValue([]);
});

describe('getPaidEntryCounts', () => {
  it('counts only entries holding a fee transaction, for every crucible', async () => {
    groupBy.mockResolvedValue([{ crucibleId: 2, _count: { _all: 1 } }]);

    const counts = await getPaidEntryCounts([1, 2]);

    expect([...counts]).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { crucibleId: { in: [1, 2] }, buzzTransactionId: { not: null } },
      })
    );
  });

  it('asks nothing for no crucibles', async () => {
    expect([...(await getPaidEntryCounts([]))]).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('withPaidEntryCount puts the count on each row', async () => {
    groupBy.mockResolvedValue([{ crucibleId: 2, _count: { _all: 2 } }]);

    const rows = await withPaidEntryCount([{ id: 1 }, { id: 2 }]);

    expect(rows).toEqual([
      { id: 1, paidEntryCount: 0 },
      { id: 2, paidEntryCount: 2 },
    ]);
  });
});

describe('prize pool surfaces', () => {
  it('the detail page gets the paid count, not the entry count', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      id: 1,
      freeEntriesPerUser: 1,
      _count: { entries: 3 },
      status: CrucibleStatus.Active,
    });
    groupBy.mockResolvedValue([{ crucibleId: 1, _count: { _all: 1 } }]);

    const detail = await getCrucibleDetail({ id: 1 });

    expect(detail?.paidEntryCount).toBe(1);
  });

  it("the viewer's active crucibles carry a pool built from paid entries", async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      {
        id: 10,
        position: null,
        crucibleId: 1,
        crucible: {
          id: 1,
          name: 'Free first',
          entryFee: 100,
          freeEntriesPerUser: 1,
          seededPrizePool: 500,
          endAt: new Date(Date.now() + 60_000),
          image: null,
          _count: { entries: 3 },
        },
      },
    ]);
    groupBy.mockResolvedValue([{ crucibleId: 1, _count: { _all: 2 } }]);

    const [active] = await getUserActiveCrucibles({ userId: 7 });

    expect(active.prizePool).toBe(700);
  });
});
