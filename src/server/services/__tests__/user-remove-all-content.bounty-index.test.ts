import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `removeAllContent` drops the account's bounties from the bounty search index, by bounty id: the
 * bounties it deleted, then those it kept, hidden, because their payout is unsettled.
 */

const { bountiesIndex, collectionsIndex, bountyService } = vi.hoisted(() => ({
  bountiesIndex: { queueUpdate: vi.fn(async () => undefined) },
  collectionsIndex: { queueUpdate: vi.fn(async () => undefined) },
  bountyService: {
    settleBountyPayout: vi.fn(async (_id: number, _opts?: unknown) => false),
    refundUnpayableBountyAward: vi.fn(async (_id: number) => false),
    claimBountyRefundForDelete: vi.fn(async (_id: number) => ({ owed: true, firstAttempt: true })),
  },
}));

// No hold covers the account here; the hold itself is `remove-all-content-legal-hold.behavior.test.ts`.
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertAccountNotUnderLegalHold: async () => ({ markerView: false }),
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
// The mocked raw reads answer every query, so the wipe finds models to soft-delete; that path is
// not this suite's.
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteModelById: vi.fn(async () => null),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteImages: vi.fn(async () => []),
}));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  refundBidsForVersions: vi.fn(async () => undefined),
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

/** The account's bounties on the primary: which have an unsettled payout, and which are open. */
let unsettled: number[] = [];
let open: number[] = [];
const BOUNTIES = [701, 702];

/** The kept-bounty list the account's bounty delete was given. */
function keptByBountyDelete() {
  const statement = vi
    .mocked(dbMock.dbWrite.$executeRaw)
    .mock.calls.map(flatten)
    .find((sql) => sql.text.includes('DELETE FROM "Bounty"'));
  if (!statement) throw new Error('no bounty delete was issued');
  // The kept list is what the statement excludes, not just a value it was handed.
  const match = /b\."userId" = \$(\d+) AND b\.id <> ALL\(\$(\d+)::int\[\]\)/.exec(statement.text);
  expect(match, 'the bounty delete excludes a kept list').not.toBeNull();
  const [userId, kept] = [match![1], match![2]].map((n) => statement.values[Number(n) - 1]);
  expect(userId).toBe(USER);
  return kept;
}
/** A tagged-template `$executeRaw` call as the one statement it sends, nested fragments flattened. */
const flatten = ([strings, ...values]: unknown[]) =>
  Prisma.sql(strings as TemplateStringsArray, ...(values as never[]));

beforeEach(() => {
  vi.clearAllMocks();
  unsettled = [];
  open = [];
  // The wipe's re-check after its evidence deletes: still unheld.
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (...args: unknown[]) => {
    const sql = flatten(args);
    // The bounties that owe a payout; only the account's own.
    if (sql.text.includes('AS pending')) {
      expect(sql.values[sql.values.length - 1]).toBe(USER);
      return BOUNTIES.filter((id) => unsettled.includes(id) || open.includes(id)).map((id) => ({
        id,
        pending: unsettled.includes(id),
        open: open.includes(id),
      }));
    }
    if (!sql.text.includes(`'removedWithOwner' = 'true'`)) return [{ held: false }];
    // Only a kept bounty still exists to carry the record; the deleted ones are gone.
    const kept = keptByBountyDelete() as number[];
    return (sql.values[0] as number[]).filter((id) => kept.includes(id)).map((id) => ({ id }));
  }) as never);
  bountyService.settleBountyPayout.mockImplementation(async () => false);
  bountyService.refundUnpayableBountyAward.mockImplementation(async () => false);
  bountyService.claimBountyRefundForDelete.mockImplementation(async () => ({
    owed: true,
    firstAttempt: true,
  }));
  // Ids distinct per table and per database, so an index fed from the wrong one is visible.
  dbMock.dbRead.bounty.findMany.mockResolvedValue([{ id: 799 }]);
  dbMock.dbWrite.collection.findMany.mockResolvedValue([{ id: 991 }]);
  // Answers only the account's own rows, so a query that drops that condition gets nothing back.
  dbMock.dbWrite.bounty.findMany.mockImplementation((async (args: {
    where: { userId?: number; id?: { notIn: number[] } };
  }) => {
    const { where } = args;
    if (where.userId !== USER) return [];
    const kept = where.id?.notIn ?? [];
    return BOUNTIES.filter((id) => !kept.includes(id)).map((id) => ({ id }));
  }) as never);
});

describe('removeAllContent and the bounty index', () => {
  it('removes the account’s bounties by bounty id, and its collections by collection id', async () => {
    await removeAllContent({ id: USER });

    expect(queued(bountiesIndex)).toEqual(del(701, 702));
    expect(queued(collectionsIndex)).toEqual(del(991));
  });

  it('removes a bounty kept for its unsettled payout after the deleted ones', async () => {
    unsettled = [702];

    await removeAllContent({ id: USER });

    expect(keptByBountyDelete()).toEqual([702]);
    expect(queued(bountiesIndex)).toEqual(del(701, 702));
  });

  it('deletes an unsettled bounty once its payout settles, and keeps the rest', async () => {
    unsettled = [701, 702];
    bountyService.settleBountyPayout.mockImplementation(async (id: number) => id === 701);

    await removeAllContent({ id: USER });

    expect(bountyService.refundUnpayableBountyAward).toHaveBeenCalledWith(702);
    expect(bountyService.refundUnpayableBountyAward).not.toHaveBeenCalledWith(701);
    expect(keptByBountyDelete()).toEqual([702]);
    expect(queued(bountiesIndex)).toEqual(del(701, 702));
  });

  it('deletes a bounty once its award is refunded, and keeps the rest', async () => {
    unsettled = [701, 702];
    bountyService.refundUnpayableBountyAward.mockImplementation(async (id: number) => id === 702);

    await removeAllContent({ id: USER });

    expect(keptByBountyDelete()).toEqual([701]);
    expect(queued(bountiesIndex)).toEqual(del(702, 701));
  });

  it('settles a pending payout before the bounty delete', async () => {
    unsettled = [701];
    bountyService.settleBountyPayout.mockImplementation(async () => true);

    await removeAllContent({ id: USER });

    const deleteCall = vi
      .mocked(dbMock.dbWrite.$executeRaw)
      .mock.calls.findIndex((call) => flatten(call).text.includes('DELETE FROM "Bounty"'));
    expect(deleteCall).toBeGreaterThanOrEqual(0);
    expect(bountyService.settleBountyPayout.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dbMock.dbWrite.$executeRaw).mock.invocationCallOrder[deleteCall]
    );
  });

  it('refunds an open bounty before deleting it, and keeps one whose refund fails', async () => {
    open = [701, 702];
    bountyService.settleBountyPayout.mockImplementation(async (id: number) => id === 701);

    await removeAllContent({ id: USER });

    expect(bountyService.claimBountyRefundForDelete.mock.calls.map(([id]) => id)).toEqual([
      701, 702,
    ]);
    expect(bountyService.settleBountyPayout).toHaveBeenCalledWith(
      701,
      expect.objectContaining({ firstAttempt: true })
    );
    expect(keptByBountyDelete()).toEqual([702]);
  });

  it('pays a pending award before claiming the rest as a refund', async () => {
    unsettled = [701];
    open = [701];
    const order: string[] = [];
    bountyService.settleBountyPayout.mockImplementation(async (id: number) => {
      order.push(`settle:${id}`);
      return true;
    });
    bountyService.claimBountyRefundForDelete.mockImplementation(async (id: number) => {
      order.push(`claim:${id}`);
      return { owed: true, firstAttempt: true };
    });

    await removeAllContent({ id: USER });

    expect(order).toEqual(['settle:701', 'claim:701', 'settle:701']);
    expect(keptByBountyDelete()).toEqual([]);
  });

  it('does not claim a bounty whose pending award could not be paid', async () => {
    unsettled = [701];
    open = [701];

    await removeAllContent({ id: USER });

    expect(bountyService.claimBountyRefundForDelete).not.toHaveBeenCalled();
    expect(keptByBountyDelete()).toEqual([701]);
  });

  it('keeps a bounty whose refund throws, and finishes the wipe', async () => {
    open = [701, 702];
    bountyService.settleBountyPayout.mockImplementation(async (id: number) => {
      if (id === 701) throw new Error('buzz down');
      return true;
    });

    await removeAllContent({ id: USER });

    expect(keptByBountyDelete()).toEqual([701]);
    expect(queued(bountiesIndex)).toEqual(del(702, 701));
  });
});
