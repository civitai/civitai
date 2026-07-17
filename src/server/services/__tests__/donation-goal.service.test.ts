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
const { mockDonationGoalsBust } = vi.hoisted(() => ({ mockDonationGoalsBust: vi.fn() }));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionPublicDonationGoalsCache: { bust: mockDonationGoalsBust },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/model-version.service', () => ({ bustMvCache: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ updateModelEarlyAccessDeadline: vi.fn() }));

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
});

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
});
