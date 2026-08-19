import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ModelStatus } from '~/shared/utils/prisma/enums';

// The refund gate on unpublishModelVersionById. Unpublishing a version revokes its buyers' access,
// so the same obligation the model-level unpublish enforces has to hold at version scope — the gate
// was absent here while the model-level one shipped, and the endpoint is owner-reachable.
//
// model-version.service.ts has a very large import graph; the transitive service/search dependencies
// are stubbed below to keep this a unit test, and the db comes from the canonical dbMock. The refund
// module itself is deliberately NOT mocked — it is the thing being reused.

const { mockTx } = vi.hoisted(() => ({
  // Separate from the write client on purpose: modelVersion.update is asserted as "inside the
  // transaction", which collapses if $transaction hands back dbWrite itself.
  mockTx: {
    modelVersion: { update: vi.fn(), findUniqueOrThrow: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

const {
  mockGetMultiAccountTransactionsByPrefix,
  mockRefundMultiAccountTransaction,
  mockGetUserBuzzAccountByAccountTypes,
} = vi.hoisted(() => ({
  mockGetMultiAccountTransactionsByPrefix: vi.fn(),
  mockRefundMultiAccountTransaction: vi.fn(),
  mockGetUserBuzzAccountByAccountTypes: vi.fn(),
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/paid-access.service', () => ({
  materializePaidAccessEndsAt: vi.fn(),
  writePaidAccessForModelVersion: vi.fn(),
  getPaidAccess: vi.fn(),
  assertPaidAccessInput: vi.fn(),
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: mockGetMultiAccountTransactionsByPrefix,
  getUserBuzzAccountByAccountTypes: mockGetUserBuzzAccountByAccountTypes,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({
  checkDonationGoalComplete: vi.fn(),
  ensureDonationGoal: vi.fn(),
  getDonationGoals: vi.fn(),
  getOwnerDonationGoals: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  ingestModelById: vi.fn().mockResolvedValue(undefined),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/monetization-rights.service', () => ({
  resolveRightsAffirmation: vi.fn(),
}));

import {
  unpublishModelVersionById,
  upsertModelVersion,
} from '~/server/services/model-version.service';
import {
  getModelVersionEarlyAccessRefundRequirement,
  toEarlyAccessRefundSummary,
} from '~/server/services/model-early-access-refund.service';
import type { SessionUser } from '~/types/session';

const MODEL_ID = 42;
const OWNER_ID = 7;
const VERSION_ID = 100;
const BUYER_ID = 555;

const HOUR = 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const boughtRecently = () => new Date(Date.now() - (WINDOW_DAYS - 1) * 24 * HOUR);
const boughtLongAgo = () => new Date(Date.now() - (WINDOW_DAYS + 1) * 24 * HOUR);

const owner = { id: OWNER_ID, isModerator: false } as SessionUser;
const moderator = { id: 9, isModerator: true } as SessionUser;

function seedPurchase({
  addedAt = boughtRecently(),
  amount = 300,
  balance = 10_000,
  gates = [{ entityId: VERSION_ID, endsAt: null }] as { entityId: number; endsAt: Date | null }[],
}: {
  addedAt?: Date | null;
  amount?: number;
  balance?: number;
  gates?: { entityId: number; endsAt: Date | null }[];
} = {}) {
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
    { id: VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
  ]);
  // 🔴 Deliberately still seeded although the requirement no longer reads PaidAccess. It is what
  // makes restoring the old gate-state filter reproduce cleanly as a mutation — remove this and the
  // four gate-state tests below stop discriminating without going red.
  dbMock.dbWrite.paidAccess.findMany.mockResolvedValue(gates);
  dbMock.dbWrite.entityAccess.findMany.mockResolvedValue([
    {
      accessToId: VERSION_ID,
      accessorId: BUYER_ID,
      meta: { 'download-buzzTransactionId': 'tx-1' },
      addedAt,
    },
  ]);
  mockGetMultiAccountTransactionsByPrefix.mockResolvedValue([{ amount, accountType: 'yellow' }]);
  mockGetUserBuzzAccountByAccountTypes.mockResolvedValue({ yellow: balance });
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({ modelId: MODEL_ID });
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
    name: 'Test Model',
    userId: OWNER_ID,
  });
}

function seedUnpublishWrites() {
  // Read inside the transaction, so it is the tx client and not dbWrite.
  mockTx.modelVersion.findUniqueOrThrow.mockResolvedValue({ status: 'Published' });
  mockTx.modelVersion.update.mockResolvedValue({
    id: VERSION_ID,
    model: { id: MODEL_ID, userId: OWNER_ID, nsfw: false },
  });
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
  seedUnpublishWrites();
});

describe('getModelVersionEarlyAccessRefundRequirement', () => {
  it('asks only for the version it was given, not every version on the model', async () => {
    seedPurchase();

    await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID });

    expect(dbMock.dbWrite.modelVersion.findMany).toHaveBeenCalledWith({
      where: { id: VERSION_ID },
      select: { id: true, meta: true },
    });
  });

  it('owes the refund on a recent purchase', async () => {
    seedPurchase();

    const requirement = await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID });

    expect(requirement.buyerCount).toBe(1);
    expect(requirement.totalBuzz).toBe(300);
    expect(requirement.purchases).toEqual([
      { modelVersionId: VERSION_ID, buyerId: BUYER_ID, buzzTransactionIds: ['tx-1'] },
    ]);
  });

  it('owes nothing on a purchase older than the window, and counts that buyer as exempt', async () => {
    seedPurchase({ addedAt: boughtLongAgo() });

    const requirement = await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID });

    expect(requirement.purchases).toEqual([]);
    expect(requirement.exemptBuyerCount).toBe(1);
  });
});

// The gate on unpublishModelVersionById is worth nothing if another owner-reachable route can take
// the version down without it. `status` is client-settable on the editor route, which is one — and
// every non-Published value takes the version off the page, because downloads and the public reads
// both gate on `status === 'Published'`.
describe('upsertModelVersion — cannot take a published version down through the editor', () => {
  beforeEach(() => {
    // `seedPurchase` also seeds `model.findUniqueOrThrow`, which upsertModelVersion reads before it
    // reaches the guard. Seeded here rather than inherited: the db mock defaults that read to null,
    // vitest clears calls but not implementations, so relying on a sibling describe makes these die
    // on a TypeError the moment anyone reorders the file.
    seedPurchase();
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      status: 'Published',
      meta: null,
      model: { id: MODEL_ID, userId: OWNER_ID, meta: null, availability: 'Public' },
      monetization: null,
    });
  });

  // Derived, not listed. A hand-written list in a test whose whole argument is that enumerations
  // rot had already lost `Training`, and would lose a ninth member the same way.
  it.each(Object.values(ModelStatus).filter((status) => status !== ModelStatus.Published))(
    'refuses %s and names the route that settles refunds',
    async (status) => {
      await expect(upsertModelVersion({ id: VERSION_ID, status } as never)).rejects.toThrowError(
        /Use the unpublish action/
      );

      expect(dbMock.dbWrite.modelVersion.update).not.toHaveBeenCalled();
    }
  );

  // Negative control. Without it a guard broadened to refuse every save of a published version —
  // which kills the resource editor outright — passes every assertion above.
  it('lets an ordinary edit of a published version through', async () => {
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });

    await upsertModelVersion({ id: VERSION_ID, name: 'renamed' } as never);

    expect(dbMock.dbWrite.modelVersion.update).toHaveBeenCalled();
  });

  // The control for the clause the others cannot see. Dropping `data.status !== Published` turns the
  // guard into "refuse any save of a published version that carries a status", which every case
  // above still passes — and which breaks declineReviewHandler, since it spreads the version's own
  // Published status back in on a review decision.
  it('lets a save that carries the current status through', async () => {
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });

    await upsertModelVersion({ id: VERSION_ID, status: 'Published', name: 'renamed' } as never);

    expect(dbMock.dbWrite.modelVersion.update).toHaveBeenCalled();
  });
});

describe('toEarlyAccessRefundSummary', () => {
  // This is what stands between the requirement and the client: the raw requirement carries every
  // buyer's id and their buzz transaction ids, and returning it unchanged would ship both.
  it('reduces the requirement to counts, keeping no buyer identity', async () => {
    seedPurchase();

    const summary = toEarlyAccessRefundSummary(
      await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID })
    );

    expect(summary).toEqual({
      purchaseCount: 1,
      buyerCount: 1,
      totalBuzz: 300,
      exemptBuyerCount: 0,
    });
  });
});

// 🔴 The shorter path to the same bypass the model-level guard closes: a moderator takes ONE
// version down, the owner unpublishes that version with no reason, and without this it lands at
// plain Unpublished with the owner as the actor — which is all the status-keyed republish gate
// checks. One call, no setup.
describe('unpublishModelVersionById — a version already taken down by a moderator', () => {
  const seedStatus = (status: string) => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
    mockTx.modelVersion.update.mockResolvedValue({
      id: VERSION_ID,
      model: { id: MODEL_ID, userId: OWNER_ID, nsfw: false },
    });
    mockTx.modelVersion.findUniqueOrThrow.mockResolvedValue({ status });
    dbMock.dbWrite.post.findMany.mockResolvedValue([]);
    dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  };

  it.each(['UnpublishedViolation', 'Deleted'])(
    'keeps %s through a reasonless owner unpublish',
    async (status) => {
      seedStatus(status);

      await unpublishModelVersionById({ id: VERSION_ID, user: owner });

      expect(mockTx.modelVersion.update.mock.calls[0][0].data.status).toBe(status);
    }
  );

  it('leaves the moderator record intact rather than restamping it', async () => {
    seedStatus('UnpublishedViolation');
    const moderatorRecord = {
      unpublishedReason: 'other',
      customMessage: 'Reviewed by a human',
      unpublishedAt: '2020-01-01T00:00:00.000Z',
      unpublishedBy: 999,
    };

    await unpublishModelVersionById({ id: VERSION_ID, user: owner, meta: { ...moderatorRecord } });

    expect(mockTx.modelVersion.update.mock.calls[0][0].data.meta).toEqual(moderatorRecord);
  });

  // Negative control: preserving unconditionally would leave every ordinary version unpublish
  // unrecorded, and each assertion above would still pass.
  it('still stamps an ordinary unpublish of a published version', async () => {
    seedStatus('Published');

    await unpublishModelVersionById({ id: VERSION_ID, user: owner });

    const data = mockTx.modelVersion.update.mock.calls[0][0].data;
    expect(data.status).toBe('Unpublished');
    expect(data.meta).toEqual(
      expect.objectContaining({ unpublishedBy: OWNER_ID, unpublishedAt: expect.any(String) })
    );
  });
});

describe('unpublishModelVersionById — refund gate', () => {
  it('refuses the unpublish when the owner has not consented to refunding', async () => {
    seedPurchase();

    await expect(unpublishModelVersionById({ id: VERSION_ID, user: owner })).rejects.toThrowError(
      /without refunding buyers/
    );

    // The point of the gate: the version is still published, nobody has been charged, and no
    // grant has been revoked — revoking before the consent check would otherwise stay green.
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.entityAccess.deleteMany).not.toHaveBeenCalled();
  });

  it('refunds the buyer, revokes the grant, then unpublishes when the owner consents', async () => {
    seedPurchase();

    await unpublishModelVersionById({ id: VERSION_ID, refundEarlyAccess: true, user: owner });

    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith({
      externalTransactionIdPrefix: 'tx-1',
      description: 'Refund early access purchase: Test Model (version unpublished)',
    });
    // Counts, not just shape: a refund issued twice debits the owner twice and pays the buyer
    // twice, and every assertion above passes while it happens.
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.entityAccess.deleteMany).toHaveBeenCalledWith({
      where: {
        accessToId: VERSION_ID,
        accessToType: 'ModelVersion',
        accessorId: BUYER_ID,
        accessorType: 'User',
      },
    });
    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  it('refuses to refund from an owner account that cannot cover the total', async () => {
    seedPurchase({ amount: 300, balance: 100 });

    await expect(
      unpublishModelVersionById({ id: VERSION_ID, refundEarlyAccess: true, user: owner })
    ).rejects.toThrowError(/300 yellow Buzz but the account only has 100/);

    // The throw has to come BEFORE the refunds. Checking affordability after paying everyone out
    // drives the owner's account negative — the ledger exempts refunds from its own sufficiency
    // check — and still throws, so asserting only the error message cannot tell the two apart.
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.entityAccess.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('unpublishes without consent once every buyer has aged out of the window', async () => {
    seedPurchase({ addedAt: boughtLongAgo() });

    await unpublishModelVersionById({ id: VERSION_ID, user: owner });

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('still owes the refund when the gate row has been cleared', async () => {
    // The hole this closes: an editor save that omits `paidAccess` deletes the gate row, and the
    // requirement used to return empty without one. Two saves and the obligation vanished.
    seedPurchase({ gates: [] });

    await expect(unpublishModelVersionById({ id: VERSION_ID, user: owner })).rejects.toThrowError(
      /without refunding buyers/
    );

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('still owes the refund when a timed window has lapsed but the purchase is recent', async () => {
    seedPurchase({ gates: [{ entityId: VERSION_ID, endsAt: new Date(Date.now() - HOUR) }] });

    await expect(unpublishModelVersionById({ id: VERSION_ID, user: owner })).rejects.toThrowError(
      /without refunding buyers/
    );

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('aborts the take-down mid-refund, keeping the count honest and the paid buyer revoked', async () => {
    // The failure path: one buyer refunded, the next refund rejects. The version must stay
    // published, the message must say how far it got, and the buyer who WAS refunded must have
    // lost their grant — otherwise a retry pays them a second time.
    seedPurchase();
    dbMock.dbWrite.entityAccess.findMany.mockResolvedValue([
      {
        accessToId: VERSION_ID,
        accessorId: BUYER_ID,
        meta: { 'download-buzzTransactionId': 'tx-1' },
        addedAt: boughtRecently(),
      },
      {
        accessToId: VERSION_ID,
        accessorId: BUYER_ID + 1,
        meta: { 'download-buzzTransactionId': 'tx-2' },
        addedAt: boughtRecently(),
      },
    ]);
    mockRefundMultiAccountTransaction
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('buzz service unavailable'));

    await expect(
      unpublishModelVersionById({ id: VERSION_ID, refundEarlyAccess: true, user: owner })
    ).rejects.toThrowError(/1 of 2 refunded.*version was not unpublished/s);

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.entityAccess.deleteMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.entityAccess.deleteMany).toHaveBeenCalledWith({
      where: {
        accessToId: VERSION_ID,
        accessToType: 'ModelVersion',
        accessorId: BUYER_ID,
        accessorType: 'User',
      },
    });
  });

  it('does not gate or refund on a moderator unpublish', async () => {
    seedPurchase();

    await unpublishModelVersionById({ id: VERSION_ID, reason: 'duplicate', user: moderator });

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    // A moderator take-down must not even price the refund — that read is the owner's gate.
    expect(dbMock.dbWrite.entityAccess.findMany).not.toHaveBeenCalled();
  });

  // Scoping lives in a SQL `where` that the db mock does not implement, so no fixture here can
  // demonstrate it by outcome — a sibling row comes back whatever the query said, and a test that
  // asserted the total would pass for the wrong reason. What IS observable is the set of ids this
  // path asks about, so that is what these assert. The behavioural half — a sibling's buyers never
  // entering the refund — is only provable against a real database.
  //
  // Both assertions now carry weight: with the gate read gone, `entityAccess.findMany`'s `in` array
  // is the flagged-version set itself, so a scope mistake shows up there directly.
  it('asks about this version alone, so a sibling can never enter the refund set', async () => {
    seedPurchase();

    await expect(unpublishModelVersionById({ id: VERSION_ID, user: owner })).rejects.toThrowError(
      /without refunding buyers/
    );

    expect(dbMock.dbWrite.modelVersion.findMany).toHaveBeenCalledWith({
      where: { id: VERSION_ID },
      select: { id: true, meta: true },
    });
    expect(dbMock.dbWrite.entityAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accessToId: { in: [VERSION_ID] } }),
      })
    );
  });
});
