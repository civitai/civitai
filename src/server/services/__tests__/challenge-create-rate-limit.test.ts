import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockGetHighestTierSubscription } = vi.hoisted(() => ({
  mockDbRead: {
    user: { findUnique: vi.fn() },
    userStrike: { count: vi.fn() },
    challenge: { count: vi.fn() },
  },
  mockGetHighestTierSubscription: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: mockGetHighestTierSubscription,
}));

const { assertUnderDailyCreateLimit, assertCanCreateUserChallenge } = await import(
  '~/server/services/challenge-eligibility.service'
);
const { CHALLENGE_CREATE_DAILY_LIMIT } = await import('~/shared/constants/challenge.constants');

const USER_ID = 42;

// In good standing, well under the active-challenge cap, so only the daily-create
// limit is exercised when assertCanCreateUserChallenge is tested end-to-end.
function mockGoodStanding() {
  mockDbRead.user.findUnique.mockResolvedValue({
    meta: { scores: { total: 999_999 } },
    bannedAt: null,
    muted: false,
    deletedAt: null,
  });
  mockDbRead.userStrike.count.mockResolvedValue(0);
  mockGetHighestTierSubscription.mockResolvedValue({ tier: 'gold' });
}

describe('assertUnderDailyCreateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when the user has hit the daily create limit', async () => {
    mockDbRead.challenge.count.mockResolvedValue(CHALLENGE_CREATE_DAILY_LIMIT);
    await expect(assertUnderDailyCreateLimit(USER_ID)).rejects.toThrow(
      /at most 5 challenges per day/i
    );
  });

  it('throws when the user has exceeded the daily create limit', async () => {
    mockDbRead.challenge.count.mockResolvedValue(CHALLENGE_CREATE_DAILY_LIMIT + 3);
    await expect(assertUnderDailyCreateLimit(USER_ID)).rejects.toThrow();
  });

  it('does not throw when the user is under the daily create limit', async () => {
    mockDbRead.challenge.count.mockResolvedValue(CHALLENGE_CREATE_DAILY_LIMIT - 1);
    await expect(assertUnderDailyCreateLimit(USER_ID)).resolves.toEqual({
      limit: CHALLENGE_CREATE_DAILY_LIMIT,
      recentCount: CHALLENGE_CREATE_DAILY_LIMIT - 1,
    });
  });

  it('queries with a 24h window scoped to the user and User source', async () => {
    mockDbRead.challenge.count.mockResolvedValue(0);
    const before = Date.now();
    await assertUnderDailyCreateLimit(USER_ID);

    expect(mockDbRead.challenge.count).toHaveBeenCalledTimes(1);
    const args = mockDbRead.challenge.count.mock.calls[0][0];
    expect(args.where.createdById).toBe(USER_ID);
    expect(args.where.source).toBe('User');
    const cutoff = args.where.createdAt.gt as Date;
    expect(cutoff.getTime()).toBeGreaterThan(before - 24 * 60 * 60 * 1000 - 1000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(before - 24 * 60 * 60 * 1000 + 1000);
  });
});

describe('assertCanCreateUserChallenge (daily limit wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoodStanding();
  });

  it('rejects creation once the daily limit is reached, even with room under the active-challenge cap', async () => {
    mockDbRead.challenge.count.mockResolvedValue(CHALLENGE_CREATE_DAILY_LIMIT);
    await expect(assertCanCreateUserChallenge(USER_ID)).rejects.toThrow(
      /at most 5 challenges per day/i
    );
  });

  it('allows creation when under both the daily and active-challenge limits', async () => {
    mockDbRead.challenge.count.mockResolvedValue(0);
    await expect(assertCanCreateUserChallenge(USER_ID)).resolves.toBeUndefined();
  });
});
