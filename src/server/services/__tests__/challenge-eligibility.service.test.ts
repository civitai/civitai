import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real exercise of the standing/score branches — no wholesale mock of
// assertUserInGoodStanding/assertUserAccountInGoodStanding. Only the DB layer they read from
// (dbRead.user, dbRead.userStrike) is mocked, so the actual gating logic runs.
const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    user: { findUnique: vi.fn() },
    userStrike: { count: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(),
}));

const { assertUserAccountInGoodStanding, assertUserInGoodStanding } = await import(
  '~/server/services/challenge-eligibility.service'
);

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
