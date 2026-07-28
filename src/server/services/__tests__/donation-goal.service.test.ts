import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `checkDonationGoalComplete` runs at the end of every donation (donateToGoal) and after an
 * early-access completion — the write paths that change a goal's total (or flip it inactive).
 * It must eagerly bust the public donation-goals cache so a donor sees the change before the
 * 60s TTL, keyed by the goal's modelVersionId (and only when the goal is tied to a version).
 */

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  });
  return {
    mockDbRead: { modelVersion: mk() },
    mockDbWrite: { donationGoal: mk(), $queryRaw: vi.fn(), $executeRaw: vi.fn() },
  };
});
const {
  mockDonationGoalsBust,
  mockLogToAxiom,
  mockBustMvCache,
  mockDataForModelsRefresh,
  mockUpdateEaDeadline,
  mockGetPaidAccess,
  mockBustPaidAccess,
  mockEndPaidAccessNow,
} = vi.hoisted(() => ({
  mockDonationGoalsBust: vi.fn(),
  mockLogToAxiom: vi.fn(),
  mockBustMvCache: vi.fn(),
  mockDataForModelsRefresh: vi.fn(),
  mockUpdateEaDeadline: vi.fn(),
  mockGetPaidAccess: vi.fn(),
  mockBustPaidAccess: vi.fn(),
  mockEndPaidAccessNow: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: mockDataForModelsRefresh },
  modelVersionPublicDonationGoalsCache: { bust: mockDonationGoalsBust },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/model-version.service', () => ({ bustMvCache: mockBustMvCache }));
vi.mock('~/server/services/model.service', () => ({
  updateModelEarlyAccessDeadline: mockUpdateEaDeadline,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: mockGetPaidAccess,
  bustPaidAccessCache: mockBustPaidAccess,
  endPaidAccessNow: mockEndPaidAccessNow,
}));

import { checkDonationGoalComplete } from '~/server/services/donation-goal.service';

const goal = (over: Record<string, unknown> = {}) => ({
  id: 10,
  goalAmount: 1000,
  title: 'Goal',
  active: true,
  userId: 7,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  entityType: 'ModelVersion',
  entityId: 5,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockLogToAxiom.mockResolvedValue(undefined);
  mockUpdateEaDeadline.mockResolvedValue(undefined);
  mockBustMvCache.mockResolvedValue(undefined);
  mockDataForModelsRefresh.mockResolvedValue(undefined);
  mockDonationGoalsBust.mockResolvedValue(undefined);
  mockBustPaidAccess.mockResolvedValue(undefined);
  mockEndPaidAccessNow.mockResolvedValue(undefined);
  mockGetPaidAccess.mockResolvedValue({});
});

// Drives the completion branch: a met goal on an entity whose PaidAccess gate is an active TIMED
// window. `donationGoalByEntity` (inside checkDonationGoalComplete) does a findFirst + $queryRaw for
// the total; the branch then flips the goal inactive, checks PaidAccess, and ends the gate.
const primeCompletionWithActiveGate = () => {
  mockDbWrite.donationGoal.findFirst.mockResolvedValueOnce(goal({ goalAmount: 1000 }));
  mockDbWrite.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 1500 }]); // >= goalAmount → met
  mockDbWrite.donationGoal.updateMany.mockResolvedValueOnce({ count: 1 });
  // Active TIMED gate (future endsAt) → there is a gate to end.
  mockGetPaidAccess.mockResolvedValueOnce({
    5: {
      entityType: 'ModelVersion',
      entityId: 5,
      ownerId: 7,
      endsAt: new Date('2099-01-01T00:00:00.000Z'),
      terms: {},
    },
  });
  mockEndPaidAccessNow.mockResolvedValueOnce(undefined);
  // syncModelAfterEarlyGateEnd resolves the version's modelId to recompute the EA deadline.
  mockDbRead.modelVersion.findUnique.mockResolvedValueOnce({ modelId: 2 });
};

describe('checkDonationGoalComplete — public cache bust', () => {
  it('busts the public donation-goals cache (keyed by version id) after a donation', async () => {
    mockDbWrite.donationGoal.findFirst.mockResolvedValueOnce(goal());
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 100 }]); // below goal → not met

    await checkDonationGoalComplete({ entityType: 'ModelVersion', entityId: 5 });

    expect(mockDonationGoalsBust).toHaveBeenCalledWith(5);
    // Not met → no goal close and no gate change.
    expect(mockDbWrite.donationGoal.updateMany).not.toHaveBeenCalled();
    expect(mockEndPaidAccessNow).not.toHaveBeenCalled();
  });

  it('routes the bust by entity type — no ModelVersion cache bust for other entities', async () => {
    mockDbWrite.donationGoal.findFirst.mockResolvedValueOnce(
      goal({ entityType: 'ComicChapter', entityId: 5 })
    );
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 100 }]);

    await checkDonationGoalComplete({ entityType: 'ComicChapter', entityId: 5 });

    expect(mockDonationGoalsBust).not.toHaveBeenCalled();
  });

  it('is FAIL-OPEN: a rejecting bust does NOT reject (never poisons the donation/refund path)', async () => {
    // A redis blip during the bust must not propagate — checkDonationGoalComplete runs inside
    // donateToGoal's try after donation.create has committed; a throw there refunds the buzz and
    // tells the donor it failed → they retry → double donation.
    mockDbWrite.donationGoal.findFirst.mockResolvedValueOnce(goal());
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 100 }]);
    mockDonationGoalsBust.mockRejectedValueOnce(new Error('redis down'));

    const result = await checkDonationGoalComplete({ entityType: 'ModelVersion', entityId: 5 });

    // Resolves normally with the goal (donation/total logic unaffected) and logs the failure.
    expect(result).toMatchObject({ id: 10, total: 100 });
    expect(mockDonationGoalsBust).toHaveBeenCalledWith(5);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'donation-goal-cache-bust-failed' })
    );
  });
});

describe('checkDonationGoalComplete — goal completion', () => {
  it('closes the goal, ends the active timed gate, busts caches, and recomputes the model EA deadline', async () => {
    primeCompletionWithActiveGate();

    const result = await checkDonationGoalComplete({ entityType: 'ModelVersion', entityId: 5 });

    expect(mockDbWrite.donationGoal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: 'ModelVersion', entityId: 5 },
        data: { active: false },
      })
    );
    expect(mockEndPaidAccessNow).toHaveBeenCalledWith('ModelVersion', 5); // PaidAccess.endsAt = NOW()
    expect(mockBustPaidAccess).toHaveBeenCalledWith('ModelVersion', [5]);
    expect(mockDonationGoalsBust).toHaveBeenCalledWith(5);
    // Early end must recompute Model.earlyAccessDeadline + refresh card/feed caches (parity with the
    // old completion path) so the model drops out of EA filters/badge immediately, not at the original
    // deadline.
    expect(mockUpdateEaDeadline).toHaveBeenCalledWith({ id: 2 });
    expect(mockBustMvCache).toHaveBeenCalledWith(5, 2);
    expect(mockDataForModelsRefresh).toHaveBeenCalledWith(2);
    expect(result).toMatchObject({ id: 10, total: 1500, active: false });
  });

  it('closes the goal but ends NO gate when the entity has no active timed PaidAccess', async () => {
    mockDbWrite.donationGoal.findFirst.mockResolvedValueOnce(goal({ goalAmount: 1000 }));
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 1500 }]); // met
    mockDbWrite.donationGoal.updateMany.mockResolvedValueOnce({ count: 1 });
    mockGetPaidAccess.mockResolvedValueOnce({}); // no gate for this entity

    await checkDonationGoalComplete({ entityType: 'ModelVersion', entityId: 5 });

    expect(mockDbWrite.donationGoal.updateMany).toHaveBeenCalled();
    expect(mockEndPaidAccessNow).not.toHaveBeenCalled();
    expect(mockBustPaidAccess).not.toHaveBeenCalled();
    expect(mockDonationGoalsBust).toHaveBeenCalledWith(5); // public bust still runs
    // No gate ended → no early-end model sync.
    expect(mockUpdateEaDeadline).not.toHaveBeenCalled();
  });

  it('is FAIL-OPEN: a rejecting access-cache bust on completion does NOT reject', async () => {
    // The paid-access cache bust does un-wrapped redis work; a transient blip must be swallowed and
    // logged, never propagated into donateToGoal's catch (→ refund on a committed donation).
    primeCompletionWithActiveGate();
    mockBustPaidAccess.mockRejectedValueOnce(new Error('redis down'));

    const result = await checkDonationGoalComplete({ entityType: 'ModelVersion', entityId: 5 });

    expect(result).toMatchObject({ id: 10, total: 1500, active: false });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'donation-goal-cache-bust-failed' })
    );
  });

  it('PROPAGATES a donationGoal.updateMany DB failure (goal-close write is NOT fail-open)', async () => {
    // A genuine DB-write failure must still throw — silently dropping goal-completion would be
    // its own bug, and this path is a legitimate error (distinct from the transient-cache class).
    mockDbWrite.donationGoal.findFirst.mockResolvedValueOnce(goal({ goalAmount: 1000 }));
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ donationGoalId: 10, total: 1500 }]);
    mockDbWrite.donationGoal.updateMany.mockRejectedValueOnce(new Error('db write failed'));

    await expect(
      checkDonationGoalComplete({ entityType: 'ModelVersion', entityId: 5 })
    ).rejects.toThrow('db write failed');
    // The cache guard never runs — the DB error short-circuits before the side-effects.
    expect(mockDonationGoalsBust).not.toHaveBeenCalled();
  });

  it('PROPAGATES a gate-end DB failure (PaidAccess write is NOT fail-open)', async () => {
    primeCompletionWithActiveGate();
    mockEndPaidAccessNow.mockReset();
    mockEndPaidAccessNow.mockRejectedValueOnce(new Error('executeRaw failed'));

    await expect(
      checkDonationGoalComplete({ entityType: 'ModelVersion', entityId: 5 })
    ).rejects.toThrow('executeRaw failed');
    expect(mockDonationGoalsBust).not.toHaveBeenCalled();
  });
});
