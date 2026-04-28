import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks ---
const { mockDbWrite, mockDbRead } = vi.hoisted(() => {
  const mk = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  });
  const writeClient = {
    referralReward: mk(),
    referralMilestone: mk(),
    referralRedemption: mk(),
    referralAttribution: mk(),
    userReferral: mk(),
    userReferralCode: mk(),
    customerSubscription: mk(),
    product: mk(),
    cosmetic: mk(),
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) =>
      cb({
        referralReward: writeClientRef.referralReward,
        referralMilestone: writeClientRef.referralMilestone,
        referralRedemption: writeClientRef.referralRedemption,
        userReferral: writeClientRef.userReferral,
        customerSubscription: writeClientRef.customerSubscription,
        $queryRaw: writeClientRef.$queryRaw,
      })
    ),
    $queryRaw: vi.fn(),
  };
  const writeClientRef = writeClient;
  const readClient = {
    referralReward: mk(),
    referralMilestone: mk(),
    userReferral: mk(),
    userReferralCode: mk(),
    customerSubscription: mk(),
    product: mk(),
    cosmetic: mk(),
  };
  return { mockDbWrite: writeClient, mockDbRead: readClient };
});

vi.mock('~/env/server', () => ({ env: {} }));
vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite, dbRead: mockDbRead }));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn().mockResolvedValue({ transactionId: 't1' }),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  grantCosmetics: vi.fn().mockResolvedValue(undefined),
}));

import { Prisma } from '@prisma/client';
import {
  collapseTierQueue,
  recordMembershipPaymentReward,
  recordBuzzPurchaseKickback,
  revokeForChargeback,
  awardMilestones,
  advanceReferralSubscriptions,
} from '../referral.service';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { ReferralRewardKind, ReferralRewardStatus } from '~/shared/utils/prisma/enums';

const resetAllMocks = () => {
  for (const [key, v] of Object.entries(mockDbWrite)) {
    if (typeof v === 'function') {
      (v as any).mockReset?.();
      continue;
    }
    if (!v) continue;
    if (key === '$transaction' || key === '$queryRaw') continue;
    for (const fn of Object.values(v as Record<string, any>)) {
      if (typeof fn?.mockReset === 'function') fn.mockReset();
    }
  }
  for (const v of Object.values(mockDbRead)) {
    for (const fn of Object.values(v as Record<string, any>)) {
      if (typeof fn?.mockReset === 'function') fn.mockReset();
    }
  }
  (mockDbWrite.$transaction as any).mockReset();
  (mockDbWrite.$transaction as any).mockImplementation(async (cb: (tx: any) => Promise<any>) =>
    cb({
      referralReward: mockDbWrite.referralReward,
      referralMilestone: mockDbWrite.referralMilestone,
      referralRedemption: mockDbWrite.referralRedemption,
      userReferral: mockDbWrite.userReferral,
      customerSubscription: mockDbWrite.customerSubscription,
      $queryRaw: mockDbWrite.$queryRaw,
    })
  );
  (mockDbWrite.$queryRaw as any).mockReset();
  (createBuzzTransaction as any).mockReset();
  (createBuzzTransaction as any).mockResolvedValue({ transactionId: 't1' });
};

beforeEach(resetAllMocks);

// -----------------------------------------------------------------------------
// collapseTierQueue — pure logic
// -----------------------------------------------------------------------------

describe('collapseTierQueue', () => {
  it('returns empty when input is empty', () => {
    expect(collapseTierQueue([])).toEqual([]);
  });

  it('drops zero-duration entries', () => {
    const out = collapseTierQueue([
      { tier: 'bronze', durationDays: 0 },
      { tier: 'gold', durationDays: 7 },
    ]);
    expect(out).toEqual([{ tier: 'gold', durationDays: 7 }]);
  });

  it('sorts tiers gold > silver > bronze regardless of input order', () => {
    const out = collapseTierQueue([
      { tier: 'bronze', durationDays: 7 },
      { tier: 'gold', durationDays: 3 },
      { tier: 'silver', durationDays: 5 },
    ]);
    expect(out.map((e) => e.tier)).toEqual(['gold', 'silver', 'bronze']);
  });

  it('collapses consecutive same-tier entries after sorting', () => {
    const out = collapseTierQueue([
      { tier: 'bronze', durationDays: 14 },
      { tier: 'bronze', durationDays: 14 },
      { tier: 'bronze', durationDays: 14 },
    ]);
    expect(out).toEqual([{ tier: 'bronze', durationDays: 42 }]);
  });

  it('collapses within a tier but keeps separation across tiers', () => {
    const out = collapseTierQueue([
      { tier: 'bronze', durationDays: 10 },
      { tier: 'gold', durationDays: 5 },
      { tier: 'bronze', durationDays: 10 },
      { tier: 'gold', durationDays: 5 },
    ]);
    expect(out).toEqual([
      { tier: 'gold', durationDays: 10 },
      { tier: 'bronze', durationDays: 20 },
    ]);
  });

  it('does not upgrade Bronze chunks into Gold (exploit prevention)', () => {
    const out = collapseTierQueue([
      { tier: 'bronze', durationDays: 365 },
      { tier: 'gold', durationDays: 1 },
    ]);
    // Gold first for its own duration, Bronze preserved
    expect(out).toEqual([
      { tier: 'gold', durationDays: 1 },
      { tier: 'bronze', durationDays: 365 },
    ]);
  });
});

// -----------------------------------------------------------------------------
// recordMembershipPaymentReward
// -----------------------------------------------------------------------------

describe('recordMembershipPaymentReward', () => {
  const basePayload = {
    refereeId: 42,
    tier: 'bronze' as const,
    monthlyBuzzAmount: 10_000,
    sourceEventId: 'inv_1',
  };

  it('returns null if no bound referrer', async () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue(null);
    const result = await recordMembershipPaymentReward(basePayload);
    expect(result).toBeNull();
    expect(mockDbWrite.referralReward.create).not.toHaveBeenCalled();
  });

  it('skips when referee has already paid 3 months (cap)', async () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: new Date(),
      paidMonthCount: 3,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2025-01-01') },
      },
    });
    const result = await recordMembershipPaymentReward(basePayload);
    expect(result).toBeNull();
    expect(mockDbWrite.referralReward.create).not.toHaveBeenCalled();
    expect(mockDbWrite.referralAttribution.create).toHaveBeenCalled();
  });

  it('creates both referrer token and referee bonus on first payment', async () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: null,
      paidMonthCount: 0,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2025-01-01') },
      },
    });
    (mockDbWrite.$queryRaw as any).mockResolvedValue([{ paidMonthCount: 0, firstPaidAt: null }]);
    mockDbWrite.referralReward.create.mockImplementation(async ({ data }: any) => ({
      id: Math.random(),
      settledAt: data.settledAt,
      ...data,
    }));
    mockDbWrite.userReferral.update.mockResolvedValue({});

    await recordMembershipPaymentReward(basePayload);

    expect(mockDbWrite.referralReward.create).toHaveBeenCalledTimes(2);
    const calls = (mockDbWrite.referralReward.create as any).mock.calls;
    const kinds = calls.map((c: any) => c[0].data.kind);
    expect(kinds).toContain(ReferralRewardKind.MembershipToken);
    expect(kinds).toContain(ReferralRewardKind.RefereeBonus);
    const refereeBonus = calls.find((c: any) => c[0].data.kind === ReferralRewardKind.RefereeBonus);
    expect(refereeBonus[0].data.buzzAmount).toBe(2_500); // 25% of 10k
    expect(refereeBonus[0].data.points).toBe(2_500);
    const memToken = calls.find((c: any) => c[0].data.kind === ReferralRewardKind.MembershipToken);
    // Bronze paid month should snapshot points = pointsPerTierMonth.bronze (1000)
    expect(memToken[0].data.points).toBe(1_000);
  });

  it('does not create referee bonus on subsequent months', async () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: new Date('2025-01-01'),
      paidMonthCount: 1,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2024-01-01') },
      },
    });
    (mockDbWrite.$queryRaw as any).mockResolvedValue([
      { paidMonthCount: 1, firstPaidAt: new Date('2025-01-01') },
    ]);
    mockDbWrite.referralReward.create.mockImplementation(async ({ data }: any) => ({
      id: 1,
      settledAt: data.settledAt,
      ...data,
    }));

    await recordMembershipPaymentReward(basePayload);

    const calls = (mockDbWrite.referralReward.create as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].data.kind).toBe(ReferralRewardKind.MembershipToken);
  });

  it('treats locked paidMonthCount > 0 as not first payment (race protection)', async () => {
    // Pre-tx ctx says paidMonthCount=0 (read from replica before lock).
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: null,
      paidMonthCount: 0,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2024-01-01') },
      },
    });
    // Inside the tx the FOR UPDATE row reflects a parallel webhook that
    // already ran: paidMonthCount=1, firstPaidAt set. Should suppress the
    // RefereeBonus, only create the MembershipToken for this invoice.
    (mockDbWrite.$queryRaw as any).mockResolvedValue([
      { paidMonthCount: 1, firstPaidAt: new Date() },
    ]);
    mockDbWrite.referralReward.create.mockImplementation(async ({ data }: any) => ({
      id: Math.random(),
      settledAt: data.settledAt,
      ...data,
    }));
    mockDbWrite.userReferral.update.mockResolvedValue({});

    await recordMembershipPaymentReward(basePayload);

    const calls = (mockDbWrite.referralReward.create as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].data.kind).toBe(ReferralRewardKind.MembershipToken);
  });

  it('returns null when locked paidMonthCount has hit the cap', async () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: new Date('2025-01-01'),
      paidMonthCount: 2, // pre-tx says ok
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2024-01-01') },
      },
    });
    // After lock: parallel writer pushed us to 3 (the cap).
    (mockDbWrite.$queryRaw as any).mockResolvedValue([
      { paidMonthCount: 3, firstPaidAt: new Date() },
    ]);

    const result = await recordMembershipPaymentReward(basePayload);
    expect(result).toBeNull();
    expect(mockDbWrite.referralReward.create).not.toHaveBeenCalled();
  });

  it('swallows unique-violation on duplicate sourceEventId (idempotent)', async () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: null,
      paidMonthCount: 0,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2024-01-01') },
      },
    });
    const err = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '1',
    });
    (mockDbWrite.$transaction as any).mockRejectedValueOnce(err);

    const result = await recordMembershipPaymentReward(basePayload);
    expect(result).toBeNull(); // no throw
  });

  it('rejects referrer accounts younger than the minimum age', async () => {
    const yesterday = new Date(Date.now() - 1 * 86_400_000);
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: null,
      paidMonthCount: 0,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: yesterday },
      },
    });

    const result = await recordMembershipPaymentReward(basePayload);
    expect(result).toBeNull();
    expect(mockDbWrite.referralReward.create).not.toHaveBeenCalled();
    expect(mockDbWrite.referralAttribution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'referrer_too_young' }),
      })
    );
  });
});

// -----------------------------------------------------------------------------
// recordBuzzPurchaseKickback
// -----------------------------------------------------------------------------

describe('recordBuzzPurchaseKickback', () => {
  it('skips kickback when referee has never paid a membership', async () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: null,
      paidMonthCount: 0,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2024-01-01') },
      },
    });
    const result = await recordBuzzPurchaseKickback({
      refereeId: 42,
      buzzAmount: 5000,
      sourceEventId: 'pi_1',
    });
    expect(result).toBeNull();
    expect(mockDbWrite.referralReward.create).not.toHaveBeenCalled();
  });

  it('grants 10% kickback when referee has firstPaidAt', async () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: new Date('2025-01-01'),
      paidMonthCount: 1,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2024-01-01') },
      },
    });
    mockDbWrite.referralReward.create.mockResolvedValue({
      id: 1,
      settledAt: new Date(),
    });
    await recordBuzzPurchaseKickback({
      refereeId: 42,
      buzzAmount: 10_000,
      sourceEventId: 'pi_1',
    });
    const data = (mockDbWrite.referralReward.create as any).mock.calls[0][0].data;
    expect(data.kind).toBe(ReferralRewardKind.BuzzKickback);
    expect(data.buzzAmount).toBe(1_000); // 10% of 10k
  });
});

// -----------------------------------------------------------------------------
// revokeForChargeback
// -----------------------------------------------------------------------------

describe('revokeForChargeback', () => {
  it('returns revoked=0 when no matching rewards', async () => {
    mockDbWrite.referralReward.findMany.mockResolvedValue([]);
    const result = await revokeForChargeback({ sourceEventId: 'pi_x', reason: 'refund' });
    expect(result).toEqual({ revoked: 0 });
  });

  it('revokes pending rewards without creating a buzz clawback', async () => {
    mockDbWrite.referralReward.findMany.mockResolvedValue([
      { id: 1, userId: 7, status: ReferralRewardStatus.Pending, buzzAmount: 0 },
    ]);
    mockDbWrite.referralReward.update.mockResolvedValue({});
    await revokeForChargeback({ sourceEventId: 'pi_1', reason: 'refund' });
    expect(createBuzzTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.referralReward.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ReferralRewardStatus.Revoked }),
      })
    );
  });

  it('claws back buzz for settled rewards that already paid out', async () => {
    mockDbWrite.referralReward.findMany.mockResolvedValue([
      { id: 2, userId: 7, status: ReferralRewardStatus.Settled, buzzAmount: 500 },
    ]);
    mockDbWrite.referralReward.update.mockResolvedValue({});
    await revokeForChargeback({ sourceEventId: 'pi_2', reason: 'refund' });
    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountId: 7,
        amount: 500,
        externalTransactionId: 'referral-clawback:2',
      })
    );
  });
});

// -----------------------------------------------------------------------------
// awardMilestones
// -----------------------------------------------------------------------------

describe('awardMilestones', () => {
  it('no-ops when user has no lifetime points', async () => {
    mockDbRead.referralReward.aggregate.mockResolvedValue({ _sum: { points: 0 } });
    await awardMilestones(7);
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('awards only milestones at or below lifetime points', async () => {
    mockDbRead.referralReward.aggregate.mockResolvedValue({ _sum: { points: 12_000 } });
    mockDbRead.cosmetic.findFirst.mockResolvedValue(null);
    await awardMilestones(7);

    // milestones 1k, 10k qualify; 50k, 200k, 1M do not. Each is an independent $transaction call.
    expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(2);
  });

  it('uses snapshotted points so config changes do not retroactively unlock milestones', async () => {
    // The aggregate is over the per-row `points` column. Even if
    // constants.referrals.pointsPerTierMonth is bumped later, the historical
    // rows keep their original snapshot, so this test is implicitly
    // confirming that the dynamic recomputation is gone.
    mockDbRead.referralReward.aggregate.mockResolvedValue({ _sum: { points: 999 } });
    await awardMilestones(7);
    // 999 < 1k threshold → nothing awarded.
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
    // Also verify aggregate was called for points (not buzzAmount).
    const aggCall = (mockDbRead.referralReward.aggregate as any).mock.calls[0];
    expect(aggCall[0]._sum).toEqual({ points: true });
  });

  it('is idempotent: unique-violation on existing milestone is swallowed', async () => {
    mockDbRead.referralReward.aggregate.mockResolvedValue({ _sum: { points: 12_000 } });
    mockDbRead.cosmetic.findFirst.mockResolvedValue(null);
    const err = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '1',
    });
    (mockDbWrite.$transaction as any)
      .mockRejectedValueOnce(err) // first milestone already exists
      .mockImplementationOnce(async (cb: any) =>
        cb({
          referralMilestone: mockDbWrite.referralMilestone,
          referralReward: mockDbWrite.referralReward,
        })
      );

    await expect(awardMilestones(7)).resolves.not.toThrow();
  });
});

// -----------------------------------------------------------------------------
// advanceReferralSubscriptions
// -----------------------------------------------------------------------------

describe('advanceReferralSubscriptions', () => {
  it('returns zero counts when nothing is due', async () => {
    mockDbWrite.customerSubscription.findMany.mockResolvedValue([]);
    const result = await advanceReferralSubscriptions();
    expect(result).toEqual({ advanced: 0, canceled: 0 });
  });

  it('cancels a sub when its queue is empty', async () => {
    mockDbWrite.customerSubscription.findMany.mockResolvedValue([
      { id: 'referral:7:1', userId: 7, metadata: { referralQueue: [] } },
    ]);
    (mockDbWrite.$queryRaw as any).mockResolvedValue([
      {
        id: 'referral:7:1',
        metadata: { referralQueue: [] },
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
    ]);
    mockDbWrite.customerSubscription.update.mockResolvedValue({});
    const result = await advanceReferralSubscriptions();
    expect(result).toEqual({ advanced: 0, canceled: 1 });
    expect(mockDbWrite.customerSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'canceled' }),
      })
    );
  });

  it('promotes the highest-tier queue entry when queue has items', async () => {
    const queueMeta = {
      referralQueue: [
        { tier: 'bronze', durationDays: 14 },
        { tier: 'silver', durationDays: 7 },
      ],
    };
    mockDbWrite.customerSubscription.findMany.mockResolvedValue([
      { id: 'referral:7:1', userId: 7, metadata: queueMeta },
    ]);
    (mockDbWrite.$queryRaw as any).mockResolvedValue([
      {
        id: 'referral:7:1',
        metadata: queueMeta,
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
    ]);
    mockDbWrite.customerSubscription.update.mockResolvedValue({});
    mockDbRead.product.findMany.mockResolvedValue([
      {
        id: 'prod_silver',
        defaultPriceId: 'price_silver',
        metadata: { tier: 'silver', referralGrantable: true },
      },
    ]);

    const result = await advanceReferralSubscriptions();

    expect(result).toEqual({ advanced: 1, canceled: 0 });
    const call = (mockDbWrite.customerSubscription.update as any).mock.calls[0][0];
    expect(call.data.productId).toBe('prod_silver');
    // After promoting silver, bronze should remain in the queue
    expect(call.data.metadata.referralQueue).toEqual([{ tier: 'bronze', durationDays: 14 }]);
  });

  it('skips promotion when no matching referralGrantable product exists', async () => {
    const queueMeta = { referralQueue: [{ tier: 'gold', durationDays: 14 }] };
    mockDbWrite.customerSubscription.findMany.mockResolvedValue([
      { id: 'referral:7:1', userId: 7, metadata: queueMeta },
    ]);
    (mockDbWrite.$queryRaw as any).mockResolvedValue([
      {
        id: 'referral:7:1',
        metadata: queueMeta,
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
    ]);
    mockDbRead.product.findMany.mockResolvedValue([]); // no matching product

    const result = await advanceReferralSubscriptions();

    expect(result).toEqual({ advanced: 0, canceled: 0 });
    expect(mockDbWrite.customerSubscription.update).not.toHaveBeenCalled();
  });

  it('skips when currentPeriodEnd has been bumped out by a parallel redeem', async () => {
    const queueMeta = { referralQueue: [{ tier: 'gold', durationDays: 14 }] };
    mockDbWrite.customerSubscription.findMany.mockResolvedValue([
      { id: 'referral:7:1', userId: 7, metadata: queueMeta },
    ]);
    // Inside the lock, the period now extends into the future — a redemption
    // raced ahead of us and extended the active chunk. Bail.
    (mockDbWrite.$queryRaw as any).mockResolvedValue([
      {
        id: 'referral:7:1',
        metadata: queueMeta,
        currentPeriodEnd: new Date(Date.now() + 60_000),
      },
    ]);

    const result = await advanceReferralSubscriptions();

    expect(result).toEqual({ advanced: 0, canceled: 0 });
    expect(mockDbWrite.customerSubscription.update).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// recordMembershipPaymentReward — inline RefereeBonus settle
// -----------------------------------------------------------------------------

describe('recordMembershipPaymentReward inline RefereeBonus settle', () => {
  const basePayload = {
    refereeId: 42,
    tier: 'bronze' as const,
    monthlyBuzzAmount: 10_000,
    sourceEventId: 'inv-inline-1',
  };

  const okCtx = () => {
    mockDbWrite.userReferral.findUnique.mockResolvedValue({
      id: 1,
      userReferralCodeId: 99,
      firstPaidAt: null,
      paidMonthCount: 0,
      userReferralCode: {
        id: 99,
        userId: 7,
        deletedAt: null,
        user: { createdAt: new Date('2024-01-01') },
      },
    });
    (mockDbWrite.$queryRaw as any).mockResolvedValue([{ paidMonthCount: 0, firstPaidAt: null }]);
    mockDbWrite.referralReward.create.mockImplementation(async ({ data }: any) => ({
      id: 555,
      buzzAmount: data.buzzAmount ?? 0,
      tokenAmount: data.tokenAmount ?? 0,
      kind: data.kind,
      userId: data.userId,
      refereeId: data.refereeId ?? null,
      tierGranted: data.tierGranted ?? null,
      ...data,
    }));
    mockDbWrite.userReferral.update.mockResolvedValue({});
  };

  it('flips RefereeBonus to Settled and grants Blue Buzz on the inline path', async () => {
    okCtx();
    mockDbWrite.referralReward.updateMany.mockResolvedValue({ count: 1 });

    await recordMembershipPaymentReward(basePayload);

    // settleRewardRow runs createBuzzTransaction with referral-reward:<id>
    const buzzCalls = (createBuzzTransaction as any).mock.calls;
    const refBonusGrant = buzzCalls.find((c: any) =>
      String(c[0].externalTransactionId).startsWith('referral-reward:')
    );
    expect(refBonusGrant).toBeTruthy();
    expect(refBonusGrant[0].toAccountId).toBe(42); // referee
    expect(refBonusGrant[0].amount).toBe(2_500); // 25% of 10k
  });

  it('reverts the inline RefereeBonus settle to Pending if buzz grant throws', async () => {
    okCtx();
    mockDbWrite.referralReward.updateMany.mockResolvedValue({ count: 1 });
    (createBuzzTransaction as any).mockImplementation(async (input: any) => {
      if (String(input.externalTransactionId).startsWith('referral-reward:')) {
        throw new Error('out of buzz');
      }
      return { transactionId: 't' };
    });

    await recordMembershipPaymentReward(basePayload);

    // settleRewardRow caught the throw and called referralReward.update to
    // restore Pending status with revokedReason populated. The cron will
    // retry on the next tick.
    const updateCalls = (mockDbWrite.referralReward.update as any).mock.calls;
    const revertCall = updateCalls.find(
      (c: any) => c[0]?.data?.status === ReferralRewardStatus.Pending && c[0]?.data?.revokedReason
    );
    expect(revertCall).toBeTruthy();
    expect(revertCall[0].data.revokedReason).toContain('out of buzz');
  });
});

// -----------------------------------------------------------------------------
// revokeForChargeback — clears UserReferral state
// -----------------------------------------------------------------------------

describe('revokeForChargeback', () => {
  it('decrements paidMonthCount and clears firstPaidAt when it drops to zero', async () => {
    mockDbWrite.referralReward.findMany.mockResolvedValue([
      {
        id: 11,
        userId: 7,
        kind: ReferralRewardKind.MembershipToken,
        refereeId: 42,
        status: ReferralRewardStatus.Settled,
        buzzAmount: 0,
      },
    ]);
    (mockDbWrite.$queryRaw as any).mockResolvedValue([{ id: 1, paidMonthCount: 1 }]);
    mockDbWrite.referralReward.update.mockResolvedValue({});
    mockDbWrite.userReferral.update.mockResolvedValue({});

    await revokeForChargeback({ sourceEventId: 'inv_x', reason: 'refunded' });

    const userReferralUpdate = (mockDbWrite.userReferral.update as any).mock.calls[0];
    expect(userReferralUpdate[0].data.paidMonthCount).toBe(0);
    expect(userReferralUpdate[0].data.firstPaidAt).toBeNull();
  });

  it('decrements but does not null firstPaidAt when paid months remain', async () => {
    mockDbWrite.referralReward.findMany.mockResolvedValue([
      {
        id: 12,
        userId: 7,
        kind: ReferralRewardKind.MembershipToken,
        refereeId: 42,
        status: ReferralRewardStatus.Settled,
        buzzAmount: 0,
      },
    ]);
    (mockDbWrite.$queryRaw as any).mockResolvedValue([{ id: 1, paidMonthCount: 3 }]);
    mockDbWrite.referralReward.update.mockResolvedValue({});
    mockDbWrite.userReferral.update.mockResolvedValue({});

    await revokeForChargeback({ sourceEventId: 'inv_y', reason: 'refunded' });

    const userReferralUpdate = (mockDbWrite.userReferral.update as any).mock.calls[0];
    expect(userReferralUpdate[0].data.paidMonthCount).toBe(2);
    expect(userReferralUpdate[0].data.firstPaidAt).toBeUndefined();
  });

  it('does not touch UserReferral when only RefereeBonus is revoked', async () => {
    mockDbWrite.referralReward.findMany.mockResolvedValue([
      {
        id: 13,
        userId: 42,
        kind: ReferralRewardKind.RefereeBonus,
        refereeId: null,
        status: ReferralRewardStatus.Settled,
        buzzAmount: 2_500,
      },
    ]);
    mockDbWrite.referralReward.update.mockResolvedValue({});

    await revokeForChargeback({ sourceEventId: 'inv_z', reason: 'refunded' });

    expect(mockDbWrite.userReferral.update).not.toHaveBeenCalled();
  });

  it('locks the UserReferral row before decrementing (no lost decrements under concurrent chargebacks)', async () => {
    mockDbWrite.referralReward.findMany.mockResolvedValue([
      {
        id: 14,
        userId: 7,
        kind: ReferralRewardKind.MembershipToken,
        refereeId: 42,
        status: ReferralRewardStatus.Settled,
        buzzAmount: 0,
      },
    ]);
    (mockDbWrite.$queryRaw as any).mockResolvedValue([{ id: 1, paidMonthCount: 2 }]);
    mockDbWrite.referralReward.update.mockResolvedValue({});
    mockDbWrite.userReferral.update.mockResolvedValue({});

    await revokeForChargeback({ sourceEventId: 'inv_w', reason: 'refunded' });

    // The row was read via FOR UPDATE inside the per-referee tx; the
    // UserReferral.findUnique path is no longer used.
    expect(mockDbWrite.$queryRaw).toHaveBeenCalled();
    expect(mockDbWrite.userReferral.findUnique).not.toHaveBeenCalled();
    const update = (mockDbWrite.userReferral.update as any).mock.calls[0];
    expect(update[0].data.paidMonthCount).toBe(1); // 2 - 1
  });
});

// -----------------------------------------------------------------------------
// computeLifetimeReferralPoints — Expired status retention
// -----------------------------------------------------------------------------

describe('computeLifetimeReferralPoints', () => {
  it('includes Expired tokens in the status filter so lifetime points do not drop', async () => {
    // We can't call the function directly here without exporting, but
    // awardMilestones uses it under the hood. Verify via the aggregate call.
    mockDbRead.referralReward.aggregate.mockResolvedValue({ _sum: { points: 12_000 } });
    mockDbRead.cosmetic.findFirst.mockResolvedValue(null);

    await awardMilestones(7);

    const aggCall = (mockDbRead.referralReward.aggregate as any).mock.calls[0];
    expect(aggCall[0].where.status.in).toEqual(
      expect.arrayContaining([
        ReferralRewardStatus.Settled,
        ReferralRewardStatus.Redeemed,
        ReferralRewardStatus.Expired,
      ])
    );
  });
});
