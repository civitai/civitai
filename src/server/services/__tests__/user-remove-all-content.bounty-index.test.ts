import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `removeAllContent` drops the account's bounties from the bounty search index: the bounties it
 * deleted, by bounty id, and not a bounty it kept because its payout is unsettled.
 */

const { bountiesIndex, collectionsIndex, bountyService } = vi.hoisted(() => ({
  bountiesIndex: { queueUpdate: vi.fn(async () => undefined) },
  collectionsIndex: { queueUpdate: vi.fn(async () => undefined) },
  bountyService: {
    settleBountyPayout: vi.fn(async () => false),
    refundUnpayableBountyAward: vi.fn(async () => false),
  },
}));

vi.mock('~/server/search-index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const idx = { queueUpdate: vi.fn(async () => undefined) };
  return {
    ...actual,
    modelsSearchIndex: idx,
    imagesSearchIndex: idx,
    imagesMetricsSearchIndex: idx,
    articlesSearchIndex: idx,
    collectionsSearchIndex: collectionsIndex,
    bountiesSearchIndex: bountiesIndex,
    usersSearchIndex: idx,
  };
});
vi.mock('~/server/metrics', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const m = { queueUpdate: vi.fn(async () => undefined) };
  return { ...actual, userMetrics: m, articleMetrics: m };
});
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteImageById: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteBidsForModel: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/bounty.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ...bountyService,
}));
vi.mock('~/server/services/apps/user-storage-purge.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  purgeUserAppStorageForAccountWipe: vi.fn(async ({ targetUserId }: { targetUserId: number }) => ({
    userId: targetUserId,
    purgeBatchId: 'apg_test',
    results: [],
    failures: [],
    unmappedSchemas: [],
    schemasTruncated: false,
    totals: { appCount: 0, deletedRowCount: 0, deletedBytes: 0 },
  })),
}));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => ({
    wipeAccount: async () => ({ namespaces: [], failures: [] }),
  }),
}));

import { removeAllContent } from '~/server/services/user.service';

const USER = 4_301;

const removedIds = (index: { queueUpdate: ReturnType<typeof vi.fn> }) =>
  index.queueUpdate.mock.calls.flatMap(([items]) => (items as { id: number }[]).map((i) => i.id));

beforeEach(() => {
  vi.clearAllMocks();
  // Distinct ids, so an index fed from the wrong table is visible.
  dbMock.dbRead.bounty.findMany.mockResolvedValue([{ id: 701 }, { id: 702 }]);
  dbMock.dbRead.collection.findMany.mockResolvedValue([{ id: 991 }]);
  dbMock.dbWrite.bounty.findMany.mockResolvedValue([]);
});

describe('removeAllContent and the bounty index', () => {
  it('removes the account’s bounties by bounty id, and its collections by collection id', async () => {
    await removeAllContent({ id: USER });

    expect(removedIds(bountiesIndex)).toEqual([701, 702]);
    expect(removedIds(collectionsIndex)).toEqual([991]);
  });

  it('keeps a bounty whose payout could not be settled in the index', async () => {
    dbMock.dbWrite.bounty.findMany.mockResolvedValue([{ id: 702 }]);

    await removeAllContent({ id: USER });

    expect(dbMock.dbWrite.bounty.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, id: { notIn: [702] } },
    });
    expect(removedIds(bountiesIndex)).toEqual([701]);
  });
});
