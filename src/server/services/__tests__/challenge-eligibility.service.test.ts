import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real exercise of the standing/score branches — no wholesale mock of
// assertUserInGoodStanding/assertUserAccountInGoodStanding. Only the DB layer they read from
// (dbRead.user, dbRead.userStrike) is mocked, so the actual gating logic runs.
const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    user: { findUnique: vi.fn() },
    userStrike: { count: vi.fn() },
    challenge: { count: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(),
}));

const { getHighestTierSubscription } = await import('~/server/services/subscriptions.service');

const {
  assertUserAccountInGoodStanding,
  assertUserInGoodStanding,
  assertCanCreateUserChallenge,
  getUserChallengeCreateEligibility,
} = await import('~/server/services/challenge-eligibility.service');

const GOOD_USER = {
  meta: { scores: { total: 10000 } },
  bannedAt: null as Date | null,
  muted: false,
  deletedAt: null as Date | null,
};

function mockUser(overrides: Partial<typeof GOOD_USER> = {}) {
  mockDbRead.user.findUnique.mockResolvedValueOnce({ ...GOOD_USER, ...overrides });
}

describe('assertUserAccountInGoodStanding (standing-only, edit gate — no score check)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.userStrike.count.mockResolvedValue(0);
  });

  it('does NOT throw when standing is good even though scoreTotal is far below the creator threshold', async () => {
    mockUser({ meta: { scores: { total: 0 } } });

    await expect(assertUserAccountInGoodStanding(1)).resolves.toMatchObject({ scoreTotal: 0 });
  });

  it('throws when the account is banned', async () => {
    mockUser({ bannedAt: new Date() });

    await expect(assertUserAccountInGoodStanding(1)).rejects.toThrow(
      'Your account is not eligible to create challenges.'
    );
  });

  it('throws when the account is deleted', async () => {
    mockUser({ deletedAt: new Date() });

    await expect(assertUserAccountInGoodStanding(1)).rejects.toThrow(
      'Your account is not eligible to create challenges.'
    );
  });

  it('throws when the account is muted', async () => {
    mockUser({ muted: true });

    await expect(assertUserAccountInGoodStanding(1)).rejects.toThrow(
      'Muted accounts cannot create challenges.'
    );
  });

  it('throws when the account has an active strike', async () => {
    mockUser();
    mockDbRead.userStrike.count.mockResolvedValueOnce(1);

    await expect(assertUserAccountInGoodStanding(1)).rejects.toThrow(
      'Resolve your active strikes before creating a challenge.'
    );
  });
});

describe('assertUserInGoodStanding (create gate — standing AND score, unchanged)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.userStrike.count.mockResolvedValue(0);
  });

  it('throws when standing is good but scoreTotal is below the creator threshold (create gate intact)', async () => {
    mockUser({ meta: { scores: { total: 4999 } } });

    await expect(assertUserInGoodStanding(1)).rejects.toThrow(
      'You need a creator score of at least 5,000 to create challenges.'
    );
  });

  it('resolves when standing is good and scoreTotal meets the creator threshold', async () => {
    mockUser({ meta: { scores: { total: 5000 } } });

    await expect(assertUserInGoodStanding(1)).resolves.toMatchObject({ scoreTotal: 5000 });
  });

  it('still throws for a muted account even with a high score', async () => {
    mockUser({ muted: true, meta: { scores: { total: 999999 } } });

    await expect(assertUserInGoodStanding(1)).rejects.toThrow(
      'Muted accounts cannot create challenges.'
    );
  });
});

describe('getUserChallengeCreateEligibility (non-throwing requirements evaluator)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Sets up the four data sources the evaluator (and the assert* gate) read, in the order they are
  // consumed: user.findUnique -> userStrike.count -> challenge.count(recent) -> challenge.count(active)
  // -> getHighestTierSubscription.
  function setup(
    opts: {
      user?: Partial<typeof GOOD_USER>;
      strikes?: number;
      recentCount?: number;
      activeCount?: number;
      tier?: string | null;
    } = {}
  ) {
    mockUser(opts.user);
    mockDbRead.userStrike.count.mockResolvedValueOnce(opts.strikes ?? 0);
    mockDbRead.challenge.count
      .mockResolvedValueOnce(opts.recentCount ?? 0)
      .mockResolvedValueOnce(opts.activeCount ?? 0);
    vi.mocked(getHighestTierSubscription).mockResolvedValue(
      (opts.tier ? { tier: opts.tier } : null) as any
    );
  }

  const req = (result: Awaited<ReturnType<typeof getUserChallengeCreateEligibility>>, key: string) =>
    result.requirements.find((r) => r.key === key)!;

  it('canCreate=true with every requirement met for an eligible user', async () => {
    setup({ tier: 'gold' });

    const result = await getUserChallengeCreateEligibility(1);

    expect(result.canCreate).toBe(true);
    expect(result.requirements.every((r) => r.met)).toBe(true);
  });

  it('marks only the score row unmet when the score is below threshold', async () => {
    setup({ user: { meta: { scores: { total: 4999 } } }, tier: 'gold' });

    const result = await getUserChallengeCreateEligibility(1);

    expect(result.canCreate).toBe(false);
    expect(req(result, 'score')).toMatchObject({ met: false, current: 4999, min: 5000 });
    expect(req(result, 'standing').met).toBe(true);
    expect(req(result, 'dailyLimit').met).toBe(true);
    expect(req(result, 'activeLimit').met).toBe(true);
  });

  it('marks the standing row unmet for a muted account', async () => {
    setup({ user: { muted: true }, tier: 'gold' });

    const result = await getUserChallengeCreateEligibility(1);

    expect(result.canCreate).toBe(false);
    expect(req(result, 'standing')).toMatchObject({ met: false, muted: true });
  });

  it('marks the standing row unmet when there are active strikes', async () => {
    setup({ strikes: 2, tier: 'gold' });

    const result = await getUserChallengeCreateEligibility(1);

    expect(req(result, 'standing')).toMatchObject({ met: false, activeStrikes: 2 });
  });

  it('marks the daily-limit row unmet when the 24h create limit is reached', async () => {
    setup({ recentCount: 5, tier: 'gold' });

    const result = await getUserChallengeCreateEligibility(1);

    expect(result.canCreate).toBe(false);
    expect(req(result, 'dailyLimit')).toMatchObject({ met: false, recentCount: 5, limit: 5 });
  });

  it('marks the active-limit row unmet using the tier limit (free tier = 1)', async () => {
    setup({ activeCount: 1, tier: null });

    const result = await getUserChallengeCreateEligibility(1);

    expect(result.canCreate).toBe(false);
    expect(req(result, 'activeLimit')).toMatchObject({ met: false, activeCount: 1, limit: 1 });
  });

  it('parity: canCreate matches whether assertCanCreateUserChallenge resolves', async () => {
    setup({ tier: 'gold' });
    const eligible = await getUserChallengeCreateEligibility(1);
    expect(eligible.canCreate).toBe(true);

    setup({ tier: 'gold' });
    await expect(assertCanCreateUserChallenge(1)).resolves.toBeUndefined();

    setup({ user: { meta: { scores: { total: 4999 } } }, tier: 'gold' });
    const ineligible = await getUserChallengeCreateEligibility(1);
    expect(ineligible.canCreate).toBe(false);

    setup({ user: { meta: { scores: { total: 4999 } } }, tier: 'gold' });
    await expect(assertCanCreateUserChallenge(1)).rejects.toThrow(
      'You need a creator score of at least 5,000 to create challenges.'
    );
  });
});
