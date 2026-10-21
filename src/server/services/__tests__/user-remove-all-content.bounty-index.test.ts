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
    settleBountyPayout: vi.fn(async (_id: number) => false),
    refundUnpayableBountyAward: vi.fn(async (_id: number) => false),
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

import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { removeAllContent } from '~/server/services/user.service';

const USER = 4_301;

/** Each queued `action:id`, so a removal queued as anything but a delete is visible. */
const queued = (index: { queueUpdate: ReturnType<typeof vi.fn> }) =>
  index.queueUpdate.mock.calls.flatMap(([items]) =>
    (items as { id: number; action: string }[]).map((i) => `${i.action}:${i.id}`)
  );
const del = (...ids: number[]) => ids.map((id) => `${SearchIndexUpdateQueueAction.Delete}:${id}`);

/** The account's bounties on the primary, and which of them have an unsettled payout. */
let unsettled: number[] = [];
const BOUNTIES = [701, 702];

beforeEach(() => {
  vi.clearAllMocks();
  unsettled = [];
  bountyService.settleBountyPayout.mockImplementation(async () => false);
  bountyService.refundUnpayableBountyAward.mockImplementation(async () => false);
  // Ids distinct per table and per database, so an index fed from the wrong one is visible.
  dbMock.dbRead.bounty.findMany.mockResolvedValue([{ id: 799 }]);
  dbMock.dbRead.collection.findMany.mockResolvedValue([{ id: 991 }]);
  dbMock.dbWrite.bounty.findMany.mockImplementation((async (args: {
    where: { payoutRecordedAt?: unknown; id?: { notIn: number[] } };
  }) => {
    if (args.where.payoutRecordedAt) return unsettled.map((id) => ({ id }));
    const kept = args.where.id?.notIn ?? [];
    return BOUNTIES.filter((id) => !kept.includes(id)).map((id) => ({ id }));
  }) as never);
});

describe('removeAllContent and the bounty index', () => {
  it('removes the account’s bounties by bounty id, and its collections by collection id', async () => {
    await removeAllContent({ id: USER });

    expect(queued(bountiesIndex)).toEqual(del(701, 702));
    expect(queued(collectionsIndex)).toEqual(del(991));
  });

  it('keeps a bounty whose payout could not be settled in the index', async () => {
    unsettled = [702];

    await removeAllContent({ id: USER });

    expect(dbMock.dbWrite.bounty.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, id: { notIn: [702] } },
    });
    expect(queued(bountiesIndex)).toEqual(del(701));
  });

  it('removes an unsettled bounty from the index once its payout settles, and only then', async () => {
    unsettled = [701, 702];
    bountyService.settleBountyPayout.mockImplementation(async (id: number) => id === 701);

    await removeAllContent({ id: USER });

    expect(bountyService.refundUnpayableBountyAward).toHaveBeenCalledWith(702);
    expect(bountyService.refundUnpayableBountyAward).not.toHaveBeenCalledWith(701);
    expect(dbMock.dbWrite.bounty.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, id: { notIn: [702] } },
    });
    expect(queued(bountiesIndex)).toEqual(del(701));
  });
});
