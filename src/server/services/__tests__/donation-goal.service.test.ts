import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `checkDonationGoalComplete` runs at the end of every donation (donateToGoal) and after an
 * early-access completion — the write paths that change a goal's total (or flip it inactive).
 * It must eagerly bust the public donation-goals cache so a donor sees the change before the
 * 60s TTL, keyed by the goal's modelVersionId (and only when the goal is tied to a version).
 */

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({ findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() });
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
} = vi.hoisted(() => ({
  mockDonationGoalsBust: vi.fn(),
  mockLogToAxiom: vi.fn(),
  mockBustMvCache: vi.fn(),
  mockDataForModelsRefresh: vi.fn(),
  mockUpdateEaDeadline: vi.fn(),
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

import { checkDonationGoalComplete } from '~/server/services/donation-goal.service';

const goal = (over: Record<string, unknown> = {}) => ({
  id: 10,
  goalAmount: 1000,
  title: 'Goal',
  active: true,
  isEarlyAccess: false,
  userId: 7,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  modelVersionId: 5,
  modelVersion: { model: { id: 2, nsfw: false } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockLogToAxiom.mockResolvedValue(undefined);
  mockUpdateEaDeadline.mockResolvedValue(undefined);
  mockBustMvCache.mockResolvedValue(undefined);
  mockDataForModelsRefresh.mockResolvedValue(undefined);
  mockDonationGoalsBust.mockResolvedValue(undefined);
});

// Drives the early-access-completion branch: a met goal that is EA-tied and still within its
// early-access window. `donationGoalById` (called inside checkDonationGoalComplete) does a
// findUniqueOrThrow + $queryRaw for the total; the branch then updates the goal, reads the
// modelVersion, runs the EA-deadline $executeRaw, and finally does the two cache side-effects.
const primeEarlyAccessCompletion = () => {
  mockDbWrite.donationGoal.findUniqueOrThrow.mockResolvedValueOnce(
    goal({ isEarlyAccess: true, goalAmount: 1000 })
  );
  mockDbWrite.$queryRaw.mockResolvedValueOnce([{ total: 1500 }]); // >= goalAmount → met
  mockDbWrite.donationGoal.update.mockResolvedValueOnce({});
  mockDbRead.modelVersion.findUnique.mockResolvedValueOnce({
    earlyAccessConfig: { timeframe: 7 },
    earlyAccessEndsAt: new Date('2099-01-01T00:00:00.000Z'), // future → EA still applies
    modelId: 2,
  });
  mockDbWrite.$executeRaw.mockResolvedValueOnce(1);
};

describe('checkDonationGoalComplete — public cache bust', () => {
  it('busts the public donation-goals cache keyed by modelVersionId after a donation', async () => {
    mockDbWrite.donationGoal.findUniqueOrThrow.mockResolvedValueOnce(goal());
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ total: 100 }]); // below goal → not met

    await checkDonationGoalComplete({ donationGoalId: 10 });

    expect(mockDonationGoalsBust).toHaveBeenCalledWith(5);
  });

  it('does not bust when the goal is not tied to a model version', async () => {
    mockDbWrite.donationGoal.findUniqueOrThrow.mockResolvedValueOnce(
      goal({ modelVersionId: null, modelVersion: null })
    );
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ total: 100 }]);

    await checkDonationGoalComplete({ donationGoalId: 10 });

    expect(mockDonationGoalsBust).not.toHaveBeenCalled();
  });

  it('is FAIL-OPEN: a rejecting bust does NOT reject (never poisons the donation/refund path)', async () => {
    // A redis blip during the bust must not propagate — checkDonationGoalComplete runs inside
    // donateToGoal's try after donation.create has committed; a throw there refunds the buzz and
    // tells the donor it failed → they retry → double donation.
    mockDbWrite.donationGoal.findUniqueOrThrow.mockResolvedValueOnce(goal());
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ total: 100 }]);
    mockDonationGoalsBust.mockRejectedValueOnce(new Error('redis down'));

    const result = await checkDonationGoalComplete({ donationGoalId: 10 });

    // Resolves normally with the goal (donation/total logic unaffected) and logs the failure.
    expect(result).toMatchObject({ id: 10, total: 100 });
    expect(mockDonationGoalsBust).toHaveBeenCalledWith(5);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'donation-goal-public-cache-bust-failed' })
    );
  });
});

describe('checkDonationGoalComplete — early-access-completion cache side-effects (double-donation guard)', () => {
  it('runs both EA cache side-effects on completion', async () => {
    primeEarlyAccessCompletion();

    const result = await checkDonationGoalComplete({ donationGoalId: 10 });

    expect(mockBustMvCache).toHaveBeenCalledWith(5, 2); // (modelVersionId, modelId)
    expect(mockDataForModelsRefresh).toHaveBeenCalledWith(2);
    expect(result).toMatchObject({ id: 10, total: 1500, active: false });
  });

  it('is FAIL-OPEN: a rejecting bustMvCache does NOT reject (never poisons the refund path)', async () => {
    // bustMvCache does un-wrapped redis work; a transient blip here previously propagated into
    // donateToGoal's catch → buzz refunded on a committed donation → donor retries → double
    // donation. It must be swallowed and logged instead.
    primeEarlyAccessCompletion();
    mockBustMvCache.mockRejectedValueOnce(new Error('redis down'));

    const result = await checkDonationGoalComplete({ donationGoalId: 10 });

    expect(result).toMatchObject({ id: 10, total: 1500 });
    expect(mockBustMvCache).toHaveBeenCalledWith(5, 2);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'donation-goal-ea-cache-refresh-failed' })
    );
  });

  it('is FAIL-OPEN: a rejecting dataForModelsCache.refresh does NOT reject', async () => {
    primeEarlyAccessCompletion();
    mockDataForModelsRefresh.mockRejectedValueOnce(new Error('redis down'));

    const result = await checkDonationGoalComplete({ donationGoalId: 10 });

    expect(result).toMatchObject({ id: 10, total: 1500 });
    expect(mockDataForModelsRefresh).toHaveBeenCalledWith(2);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'donation-goal-ea-cache-refresh-failed' })
    );
  });

  it('does NOT swallow the goal-completion DB write ($executeRaw succeeds) — EA cache guard is scoped to the cache ops only', async () => {
    // The donationGoal.update + $executeRaw EA-deadline writes are legitimate state changes and
    // must remain OUTSIDE the fail-open guard so a real DB failure still surfaces (see below).
    primeEarlyAccessCompletion();

    await checkDonationGoalComplete({ donationGoalId: 10 });

    expect(mockDbWrite.donationGoal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 10 }, data: { active: false } })
    );
    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('PROPAGATES a donationGoal.update DB failure (goal-completion write is NOT fail-open)', async () => {
    // A genuine DB-write failure must still throw — silently dropping goal-completion would be
    // its own bug, and this path is a legitimate error (distinct from the transient-cache class).
    mockDbWrite.donationGoal.findUniqueOrThrow.mockResolvedValueOnce(
      goal({ isEarlyAccess: true, goalAmount: 1000 })
    );
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ total: 1500 }]);
    mockDbWrite.donationGoal.update.mockRejectedValueOnce(new Error('db write failed'));

    await expect(checkDonationGoalComplete({ donationGoalId: 10 })).rejects.toThrow(
      'db write failed'
    );
    // The cache guard never runs — the DB error short-circuits before the side-effects.
    expect(mockBustMvCache).not.toHaveBeenCalled();
  });

  it('PROPAGATES an EA-deadline $executeRaw DB failure (EA-unlock write is NOT fail-open)', async () => {
    primeEarlyAccessCompletion();
    mockDbWrite.$executeRaw.mockReset();
    mockDbWrite.$executeRaw.mockRejectedValueOnce(new Error('executeRaw failed'));

    await expect(checkDonationGoalComplete({ donationGoalId: 10 })).rejects.toThrow(
      'executeRaw failed'
    );
    expect(mockBustMvCache).not.toHaveBeenCalled();
  });
});
