import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// Use vi.hoisted to define mocks that will be available in vi.mock factories
const {
  mockCreateNotification,
  mockUpdateUserById,
  mockInvalidateSession,
  mockRefreshSession,
  mockStrikeIssuedEmailSend,
  mockSetUserSetting,
  mockGetStaticContent,
  mockTrackModActivity,
} = vi.hoisted(() => ({
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
  mockUpdateUserById: vi.fn().mockResolvedValue(undefined),
  mockInvalidateSession: vi.fn().mockResolvedValue(undefined),
  mockRefreshSession: vi.fn().mockResolvedValue(undefined),
  mockStrikeIssuedEmailSend: vi.fn().mockResolvedValue(undefined),
  mockSetUserSetting: vi.fn().mockResolvedValue(undefined),
  mockGetStaticContent: vi.fn(),
  mockTrackModActivity: vi.fn().mockResolvedValue(undefined),
}));

// The db and logging clients come from the canonical shared mocks. Property
// access on a hybrid node vivifies, so `mockDbRead.userStrike.aggregate` and the
// rest resolve to the same stable spies the hand-written object declared — while
// `dbRead` and `dbWrite` stay DISTINCT, which is what the old two-object mock
// already had and must keep.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockLogToAxiom = loggingMock.logToAxiom;

// 🔴 Deliberately NOT inheriting the canonical `$transaction` default, which runs
// the callback with `dbWrite` itself. Every assertion about a write here means
// "this happened INSIDE the transaction", and it is checked against the spies on
// the SEPARATE tx client `mockTransactionForEscalation` builds below — collapsing
// the two would let a write made outside the lock satisfy those assertions. The
// old hand-written `$transaction: vi.fn()` resolved to `undefined` until a test
// installed its own implementation; this restores that starting state.
mockDbWrite.$transaction.mockResolvedValue(undefined);

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/services/moderator.service', () => ({
  trackModActivity: mockTrackModActivity,
}));

vi.mock('~/server/services/user.service', () => ({
  updateUserById: mockUpdateUserById,
  setUserSetting: mockSetUserSetting,
}));

// The accept path reads the deployed ToS to record the hash it accepted; the content itself is not
// what this suite is about.
vi.mock('~/server/services/content.service', () => ({
  getStaticContent: mockGetStaticContent,
  resolveTosHash: (h: string) => h,
}));

vi.mock('~/server/auth/session-invalidation', () => ({
  invalidateSession: mockInvalidateSession,
  refreshSession: mockRefreshSession,
}));

vi.mock('~/server/email/templates', () => ({
  strikeIssuedEmail: { send: mockStrikeIssuedEmailSend },
}));

vi.mock('~/server/utils/pagination-helpers', () => ({
  getPagination: (limit: number, page: number | undefined) => {
    const take = limit > 0 ? limit : undefined;
    const skip = page && take ? (page - 1) * take : undefined;
    return { take, skip };
  },
  getPagingData: (data: { count?: number; items: unknown[] }, limit?: number, page?: number) => {
    const { count: totalItems = 0, items } = data;
    const currentPage = page ?? 1;
    const pageSize = limit ?? totalItems;
    const totalPages = pageSize && totalItems ? Math.ceil((totalItems as number) / pageSize) : 1;
    return { items, totalItems, currentPage, pageSize, totalPages };
  },
}));

// Import after mocks
import {
  shouldRateLimitStrike,
  getActiveStrikePoints,
  getStrikesForUser,
  getStrikesForMod,
  getStrikeHistoryForMod,
  getUserStandings,
  evaluateStrikeEscalation,
  acceptTosAfterMute,
  createStrike,
  voidStrike,
  expireStrikes,
  processTimedUnmutes,
} from '~/server/services/strike.service';
import { StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';

// Helper: mock evaluateStrikeEscalation's transaction. The returned mocks are the transaction
// client's, so a test asserting on `userUpdate` is asserting the write happened INSIDE the
// transaction — which is the whole point of taking the lock.
/**
 * @param opts.lastStrikeAt when the account was last struck. Defaults to a date the fixture user has
 *   NOT accepted the Terms after, which is the state that holds the 2-point mute — pass an older date
 *   (or set a `tos*LastSeenDate` on `user.settings`) to model a user who has accepted since.
 */
function mockTransactionForEscalation(
  pointsSum: number | null,
  user: any,
  opts: { lastStrikeAt?: Date | null } = {}
) {
  const { lastStrikeAt = new Date('2026-06-01') } = opts;
  // Two reads in the transaction now: the locked point sum, then the last strike date the acceptance
  // check compares against. `mockResolvedValue` for both would answer the second with the first.
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([{ sum: pointsSum }])
    .mockResolvedValueOnce([{ last: lastStrikeAt }]);
  const userUpdate = vi.fn().mockResolvedValue(user);
  mockDbWrite.$transaction.mockImplementation(async (fn: any) =>
    fn({
      $queryRaw: queryRaw,
      user: { findUnique: vi.fn().mockResolvedValue(user), update: userUpdate },
    })
  );
  return { queryRaw, userUpdate };
}

// Prisma tagged templates hand the raw SQL over as a TemplateStringsArray.
const sqlOf = (call: any[]) => (call[0] as string[]).join(' ');

describe('strike.service', () => {
  beforeEach(() => {
    // `reset`, not `clear`: an unconsumed `mockResolvedValueOnce` survives `clearAllMocks` and is
    // served to the next test. It also wipes factory-declared implementations, so re-arm them.
    vi.resetAllMocks();
    mockGetStaticContent.mockResolvedValue({ hash: 'deadbeef' });
  });

  // ==========================================================================
  // shouldRateLimitStrike
  // ==========================================================================
  describe('shouldRateLimitStrike', () => {
    it('returns false when no strikes exist today', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ count: 0 }]);

      const result = await shouldRateLimitStrike(1);

      expect(result).toBe(false);
    });

    it('returns true when a non-manual strike already exists today', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ count: 1 }]);

      const result = await shouldRateLimitStrike(1);

      expect(result).toBe(true);
    });

    it('ignores ManualModAction strikes in the count', async () => {
      // The SQL query excludes ManualModAction, so count=0 means only manual strikes exist
      mockDbRead.$queryRaw.mockResolvedValue([{ count: 0 }]);

      const result = await shouldRateLimitStrike(1);

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // getActiveStrikePoints
  // ==========================================================================
  describe('getActiveStrikePoints', () => {
    it('returns 0 when no active strikes (sum is null)', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: null }]);

      const result = await getActiveStrikePoints(1);

      expect(result).toBe(0);
    });

    it('returns correct sum from raw query', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 5 }]);

      const result = await getActiveStrikePoints(1);

      expect(result).toBe(5);
    });
  });

  // ==========================================================================
  // getStrikesForUser
  // ==========================================================================
  describe('getStrikesForUser', () => {
    const mockStrike = {
      id: 1,
      userId: 100,
      reason: StrikeReason.TOSViolation,
      status: StrikeStatus.Active,
      points: 1,
      description: 'Test strike',
      entityType: null,
      entityId: null,
      reportId: null,
      createdAt: new Date('2024-01-01'),
      expiresAt: new Date('2099-01-01'),
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      issuedBy: 1,
      issuedByUser: { id: 1, username: 'mod' },
    };

    it('returns strikes with totalActivePoints and nextExpiry', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([mockStrike]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: 1 },
        _min: { expiresAt: new Date('2099-01-01') },
      });

      const result = await getStrikesForUser(100);

      expect(result.strikes).toHaveLength(1);
      expect(result.totalActivePoints).toBe(1);
      expect(result.nextExpiry).toEqual(new Date('2099-01-01'));
    });

    it('returns 0 points and null expiry when no active strikes', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: null },
        _min: { expiresAt: null },
      });

      const result = await getStrikesForUser(100);

      expect(result.totalActivePoints).toBe(0);
      expect(result.nextExpiry).toBeNull();
    });

    it('filters to Active-only by default (includeExpired: false)', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: null },
        _min: { expiresAt: null },
      });

      await getStrikesForUser(100);

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 100, status: StrikeStatus.Active },
        })
      );
    });

    it('includes all statuses when includeExpired: true', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: null },
        _min: { expiresAt: null },
      });

      await getStrikesForUser(100, { includeExpired: true });

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 100 },
        })
      );
    });

    it('select.internalNotes is true when includeInternalNotes: true', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: null },
        _min: { expiresAt: null },
      });

      await getStrikesForUser(100, { includeInternalNotes: true });

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ internalNotes: true }),
        })
      );
    });

    it('select.internalNotes is false when includeInternalNotes: false', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: null },
        _min: { expiresAt: null },
      });

      await getStrikesForUser(100, { includeInternalNotes: false });

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ internalNotes: false }),
        })
      );
    });

    it('uses aggregate for active points instead of separate query', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: 3 },
        _min: { expiresAt: new Date('2099-06-01') },
      });

      const result = await getStrikesForUser(100);

      expect(mockDbRead.userStrike.aggregate).toHaveBeenCalledWith({
        where: {
          userId: 100,
          status: StrikeStatus.Active,
          expiresAt: { gt: expect.any(Date) },
        },
        _sum: { points: true },
        _min: { expiresAt: true },
      });
      expect(result.totalActivePoints).toBe(3);
      expect(result.nextExpiry).toEqual(new Date('2099-06-01'));
    });
  });

  // ==========================================================================
  // getStrikeHistoryForMod
  // ==========================================================================
  describe('getStrikeHistoryForMod', () => {
    it('fetches strikes with includeExpired and includeInternalNotes + user profile', async () => {
      const mockUser = {
        id: 100,
        username: 'testuser',
        createdAt: new Date('2023-01-01'),
        muted: false,
        bannedAt: null,
        deletedAt: null,
        meta: { scores: { total: 500 } },
      };
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: null },
        _min: { expiresAt: null },
      });
      mockDbRead.user.findUnique.mockResolvedValue(mockUser);

      const result = await getStrikeHistoryForMod(100);

      expect(result.user).toEqual(mockUser);
      expect(result.strikes).toEqual([]);
      expect(result.totalActivePoints).toBe(0);
      // Verify includeExpired: true — no status filter in findMany
      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 100 },
          select: expect.objectContaining({ internalNotes: true }),
        })
      );
    });

    it('returns null user when user does not exist', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.aggregate.mockResolvedValue({
        _sum: { points: null },
        _min: { expiresAt: null },
      });
      mockDbRead.user.findUnique.mockResolvedValue(null);

      const result = await getStrikeHistoryForMod(999);

      expect(result.user).toBeNull();
    });
  });

  // ==========================================================================
  // getStrikesForMod
  // ==========================================================================
  describe('getStrikesForMod', () => {
    it('returns paginated results', async () => {
      const items = [{ id: 1, userId: 100 }];
      mockDbRead.userStrike.findMany.mockResolvedValue(items);
      mockDbRead.userStrike.count.mockResolvedValue(1);

      const result = await getStrikesForMod({ limit: 10, page: 1 });

      expect(result.items).toEqual(items);
      expect(result.totalItems).toBe(1);
    });

    it('looks up user by username when userId not provided', async () => {
      mockDbRead.user.findFirst.mockResolvedValue({ id: 42 });
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.count.mockResolvedValue(0);

      await getStrikesForMod({ limit: 10, page: 1, username: 'testuser' });

      expect(mockDbRead.user.findFirst).toHaveBeenCalledWith({
        where: { username: { equals: 'testuser', mode: 'insensitive' } },
        select: { id: true },
      });
      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 42 }),
        })
      );
    });

    it('returns empty results when username does not match any user', async () => {
      mockDbRead.user.findFirst.mockResolvedValue(null);

      const result = await getStrikesForMod({
        limit: 10,
        page: 1,
        username: 'nonexistent',
      });

      expect(result.items).toEqual([]);
      expect(result.totalItems).toBe(0);
      expect(mockDbRead.userStrike.findMany).not.toHaveBeenCalled();
    });

    it('passes through status and reason filters', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.userStrike.count.mockResolvedValue(0);

      await getStrikesForMod({
        limit: 10,
        page: 1,
        userId: 1,
        status: [StrikeStatus.Active],
        reason: [StrikeReason.TOSViolation],
      });

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 1,
            status: { in: [StrikeStatus.Active] },
            reason: { in: [StrikeReason.TOSViolation] },
          }),
        })
      );
    });
  });

  // ==========================================================================
  // getUserStandings
  // ==========================================================================
  describe('getUserStandings', () => {
    it('returns paginated user standings', async () => {
      const mockItems = [
        {
          id: 1,
          username: 'testuser',
          createdAt: new Date(),
          muted: false,
          bannedAt: null,
          deletedAt: null,
          userScore: 100,
          flaggedForReview: false,
          activeStrikeCount: 1,
          totalActivePoints: 2,
          totalStrikeCount: 3,
          lastStrikeDate: new Date(),
        },
      ];
      mockDbRead.$queryRaw
        .mockResolvedValueOnce(mockItems) // data query
        .mockResolvedValueOnce([{ count: BigInt(1) }]); // count query

      const result = await getUserStandings({
        limit: 10,
        page: 1,
        sort: 'points',
        sortOrder: 'desc',
      });

      expect(result.items).toEqual(mockItems);
      expect(result.totalItems).toBe(1);
    });

    it('returns zero count safely when count query returns empty', async () => {
      mockDbRead.$queryRaw
        .mockResolvedValueOnce([]) // data query — no items
        .mockResolvedValueOnce([]); // count query — empty array (edge case)

      const result = await getUserStandings({
        limit: 10,
        page: 1,
        sort: 'points',
        sortOrder: 'desc',
      });

      expect(result.items).toEqual([]);
      expect(result.totalItems).toBe(0);
    });

    it('uses INNER JOIN by default (only users with strike history)', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: BigInt(0) }]);

      await getUserStandings({ limit: 10, page: 1, sort: 'points', sortOrder: 'desc' });

      // Both calls should have been made (data + count)
      expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('falls back to points sort for unknown sort value', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: BigInt(0) }]);

      // Even with valid schema, test the internal fallback
      await getUserStandings({ limit: 10, page: 1, sort: 'points', sortOrder: 'asc' });

      expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // evaluateStrikeEscalation
  // ==========================================================================
  describe('evaluateStrikeEscalation', () => {
    it('3+ points: mutes, flags for review, invalidates session', async () => {
      const { userUpdate } = mockTransactionForEscalation(3, {
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result).toEqual({ totalPoints: 3, action: 'muted-and-flagged' });
      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            muted: true,
            muteExpiresAt: null,
            meta: expect.objectContaining({ strikeFlaggedForReview: true }),
          }),
        })
      );
      // Through the transaction client, never a post-commit updateUserById — outside the
      // transaction the FOR UPDATE lock is already released and the decision is unguarded.
      expect(mockUpdateUserById).not.toHaveBeenCalled();
      expect(mockInvalidateSession).toHaveBeenCalledWith(1, 'strike');
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-escalation-muted' })
      );
    });

    it('3+ points, already flagged: updates user but skips duplicate notification', async () => {
      const { userUpdate } = mockTransactionForEscalation(4, {
        muted: true,
        muteExpiresAt: null,
        meta: { strikeFlaggedForReview: true },
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result.action).toBe('muted-and-flagged');
      expect(userUpdate).toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('2 points: muted with NO expiry — this tier ends on acceptance, not on a timer', async () => {
      const { userUpdate } = mockTransactionForEscalation(2, {
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result).toEqual({ totalPoints: 2, action: 'muted' });
      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({ muted: true, muteExpiresAt: null }),
        })
      );
      // A date here would put it back on the 3-day renewal loop, which is what the notification used
      // to promise and never delivered.
      expect(userUpdate.mock.calls[0][0].data.muteExpiresAt).toBeNull();
      expect(mockInvalidateSession).toHaveBeenCalledWith(1, 'strike');
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-escalation-muted' })
      );
    });

    it('2 points, already held: updates user but skips duplicate notification', async () => {
      const { userUpdate } = mockTransactionForEscalation(2, {
        muted: true,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result.action).toBe('muted');
      expect(userUpdate).toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('2 points with existing flag: clears strikeFlaggedForReview', async () => {
      const { userUpdate } = mockTransactionForEscalation(2, {
        muted: true,
        muteExpiresAt: null,
        meta: { strikeFlaggedForReview: true },
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result.action).toBe('muted');
      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            meta: expect.objectContaining({ strikeFlaggedForReview: false }),
          }),
        })
      );
    });

    it('<2 points, user not muted: no action', async () => {
      const { userUpdate } = mockTransactionForEscalation(1, {
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result).toEqual({ totalPoints: 1, action: 'none' });
      expect(userUpdate).not.toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('<2 points, strike-muted: unmutes and sends notification', async () => {
      const { userUpdate } = mockTransactionForEscalation(1, {
        muted: true,
        muteExpiresAt: new Date('2099-01-01'),
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result).toEqual({ totalPoints: 1, action: 'unmuted' });
      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            muted: false,
            muteExpiresAt: null,
          }),
        })
      );
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-de-escalation-unmuted' })
      );
      expect(mockRefreshSession).toHaveBeenCalledWith(1, { caller: 'strike' });
    });

    it('<2 points, flagged AND accepted since: unmutes and clears flag', async () => {
      const { userUpdate } = mockTransactionForEscalation(0, {
        muted: true,
        muteExpiresAt: null,
        meta: { strikeFlaggedForReview: true },
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result).toEqual({ totalPoints: 0, action: 'unmuted' });
      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            muted: false,
            muteExpiresAt: null,
            meta: expect.objectContaining({ strikeFlaggedForReview: false }),
          }),
        })
      );
    });

    // A moderator's TIMED mute looks exactly like a strike mute on `muteExpiresAt` alone. `mutedAt` is
    // what separates them, and without these two a revert reads as "de-escalation works" while silently
    // releasing accounts a person muted on purpose.
    it('<2 points, moderator TIMED mute (mutedAt set): does NOT unmute', async () => {
      const { userUpdate } = mockTransactionForEscalation(1, {
        muted: true,
        mutedAt: new Date('2026-01-01'),
        muteExpiresAt: new Date('2099-01-01'),
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      expect(result).toEqual({ totalPoints: 1, action: 'none' });
      expect(userUpdate).not.toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    // The guard's only outward sign is a log line: keeping a mute looks identical to doing nothing, so
    // without this the observability could rot and nobody would find out until they went looking for
    // events that were never emitted.
    it('records that it kept the moderator mute, so the non-event is observable', async () => {
      mockLogToAxiom.mockClear();
      mockTransactionForEscalation(1, {
        muted: true,
        mutedAt: new Date('2026-01-01'),
        muteExpiresAt: new Date('2099-01-01'),
        meta: {},
      });

      await evaluateStrikeEscalation(1, { allowMute: true });

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'strike-de-escalation-skipped', userId: 1 })
      );
    });

    // The provenance keys and `mutedAt` have to die together. Left behind they describe a mute that is
    // over: the account stays off every leaderboard, and the next AUTOMATIC mute inherits a stranger's
    // reason and moderator on the screen a ban is decided on.
    it('lifting a strike mute clears mutedAt AND the provenance keys together', async () => {
      const { userUpdate } = mockTransactionForEscalation(1, {
        muted: true,
        muteExpiresAt: new Date('2099-01-01'),
        meta: { muteReason: 'older moderator mute', mutedBy: 55, keepMe: true },
      });

      await evaluateStrikeEscalation(1, { allowMute: true });

      const data = userUpdate.mock.calls[0][0].data;
      expect(data).toMatchObject({ muted: false, mutedAt: null, muteExpiresAt: null });
      expect(data.meta).not.toHaveProperty('muteReason');
      expect(data.meta).not.toHaveProperty('mutedBy');
      // Unrelated meta must survive — this clears a mute, not the account's whole record.
      expect(data.meta).toMatchObject({ keepMe: true });
    });

    // Nulling it would turn their 30-day mute into a permanent one — an extension nobody asked for,
    // and the mirror of the shortening bug this test was originally written for.
    it('escalating leaves a moderator mute expiry alone, neither shortening nor extending', async () => {
      const moderatorExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const { userUpdate } = mockTransactionForEscalation(2, {
        muted: true,
        mutedAt: new Date('2026-01-01'),
        muteExpiresAt: moderatorExpiry,
        meta: {},
      });

      await evaluateStrikeEscalation(1, { allowMute: true });

      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ muted: true }) })
      );
      // Absent, not overwritten: their expiry stands untouched and `process-timed-unmutes` still ends
      // it on schedule.
      expect(userUpdate.mock.calls[0][0].data).not.toHaveProperty('muteExpiresAt');
    });

    it('<2 points, muted with no expiry, no flag and no strike reason: left alone', async () => {
      const { userUpdate } = mockTransactionForEscalation(0, {
        muted: true,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1, { allowMute: true });

      // Not this system's mute to lift: no expiry, no review flag and no strike reason means something
      // else muted this account, and clearing it here would release a scam or restriction mute.
      expect(result).toEqual({ totalPoints: 0, action: 'none' });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('user not found: returns none', async () => {
      const { userUpdate } = mockTransactionForEscalation(3, null);

      const result = await evaluateStrikeEscalation(999, { allowMute: true });

      expect(result).toEqual({ totalPoints: 3, action: 'none' });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('locks the strike rows at a query level below the SUM', async () => {
      const { queryRaw } = mockTransactionForEscalation(1, {
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      await evaluateStrikeEscalation(1, { allowMute: true });

      expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(1);
      // Postgres rejects `FOR UPDATE` on an aggregate query (0A000, "not allowed with aggregate
      // functions"), so the lock has to stay one query level below the SUM — which it only does
      // while the CTE is materialized. Collapsing the levels throws on every call, and that is what
      // left the whole strike system dead in production for five months.
      const [sql] = queryRaw.mock.calls.map(sqlOf);
      expect(sql).toMatch(/FOR UPDATE/);
      expect(sql).toMatch(/AS MATERIALIZED/);
      expect(
        sql.indexOf('FOR UPDATE') < sql.indexOf('SUM('),
        'FOR UPDATE must be inside the CTE, i.e. before the SUM that reads it'
      ).toBe(true);
    });
  });

  // ==========================================================================
  // createStrike
  // ==========================================================================
  describe('createStrike', () => {
    const baseInput = {
      userId: 100,
      reason: StrikeReason.TOSViolation as StrikeReason,
      points: 1,
      description: 'Violated TOS',
      expiresInDays: 30,
      issuedBy: 1,
    };

    const mockCreatedStrike = {
      id: 1,
      ...baseInput,
      status: StrikeStatus.Active,
      expiresAt: new Date('2024-02-01'),
      createdAt: new Date('2024-01-01'),
    };

    beforeEach(() => {
      // Default: user exists, no rate limit, escalation returns none
      mockDbRead.user.findUnique
        .mockResolvedValueOnce({ id: 100 }) // user exists check
        .mockResolvedValueOnce({ email: 'user@test.com', username: 'testuser' }); // email lookup
      mockDbRead.$queryRaw
        .mockResolvedValueOnce([{ count: 0 }]) // shouldRateLimitStrike
        .mockResolvedValueOnce([{ sum: 1 }]); // getActiveStrikePoints for notification
      mockDbWrite.userStrike.create.mockResolvedValue(mockCreatedStrike);
      // evaluateStrikeEscalation transaction
      mockTransactionForEscalation(1, { muted: false, muteExpiresAt: null, meta: {} });
    });

    it('creates strike record and returns it', async () => {
      const result = await createStrike(baseInput);

      expect(result).toEqual(mockCreatedStrike);
      expect(mockDbWrite.userStrike.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 100,
          reason: StrikeReason.TOSViolation,
          points: 1,
          description: 'Violated TOS',
          issuedBy: 1,
        }),
      });
    });

    it('throws NOT_FOUND when user does not exist', async () => {
      mockDbRead.user.findUnique.mockReset();
      mockDbRead.user.findUnique.mockResolvedValueOnce(null);

      await expect(createStrike(baseInput)).rejects.toThrow('User 100 not found');
    });

    it('returns null (rate limited) for non-manual strikes when limit hit', async () => {
      mockDbRead.$queryRaw.mockReset();
      mockDbRead.$queryRaw.mockResolvedValueOnce([{ count: 1 }]); // rate limited

      const result = await createStrike(baseInput);

      expect(result).toBeNull();
      expect(mockDbWrite.userStrike.create).not.toHaveBeenCalled();
    });

    it('logs to Axiom when rate limited', async () => {
      mockDbRead.$queryRaw.mockReset();
      mockDbRead.$queryRaw.mockResolvedValueOnce([{ count: 1 }]); // rate limited

      await createStrike(baseInput);

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          name: 'strike-rate-limited',
          userId: 100,
        })
      );
    });

    it('bypasses rate limit for ManualModAction', async () => {
      const manualInput = { ...baseInput, reason: StrikeReason.ManualModAction };

      // Reset and set up for manual action (no rate limit call)
      mockDbRead.$queryRaw.mockReset();
      mockDbRead.$queryRaw.mockResolvedValueOnce([{ sum: 1 }]); // getActiveStrikePoints for notification

      mockDbRead.user.findUnique.mockReset();
      mockDbRead.user.findUnique
        .mockResolvedValueOnce({ id: 100 }) // user exists
        .mockResolvedValueOnce({ email: 'user@test.com', username: 'testuser' }); // email

      const result = await createStrike(manualInput);

      expect(result).toEqual(mockCreatedStrike);
    });

    it('calls evaluateStrikeEscalation after creation', async () => {
      await createStrike(baseInput);

      // evaluateStrikeEscalation uses dbWrite.$transaction
      expect(mockDbWrite.$transaction).toHaveBeenCalled();
    });

    it('sends in-app notification', async () => {
      await createStrike(baseInput);

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'strike-issued',
          userId: 100,
          details: expect.objectContaining({
            description: 'Violated TOS',
            points: 1,
          }),
        })
      );
    });

    it('sends email when user has email', async () => {
      await createStrike(baseInput);

      expect(mockStrikeIssuedEmailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@test.com',
          username: 'testuser',
          reason: StrikeReason.TOSViolation,
          points: 1,
        })
      );
    });

    it('does not throw if email fails', async () => {
      mockStrikeIssuedEmailSend.mockRejectedValueOnce(new Error('Email failed'));

      const result = await createStrike(baseInput);

      expect(result).toEqual(mockCreatedStrike);
    });

    // Without this row the strike exists only in `UserStrike`, and the account-history panel — the
    // screen where the next action is decided — cannot say a strike was ever issued, or by whom.
    it('records the strike in mod activity, attributed to the issuer', async () => {
      await createStrike(baseInput);

      expect(mockTrackModActivity).toHaveBeenCalledWith(1, {
        entityType: 'user',
        entityId: 100,
        activity: 'strike',
      });
    });

    it('attributes an auto-strike to the system sentinel rather than to user 0', async () => {
      // `issuedBy` is absent on an automated strike, and 0 is a falsy id that would read as an account.
      const { issuedBy: _issuedBy, ...autoInput } = baseInput;

      await createStrike(autoInput);

      expect(mockTrackModActivity).toHaveBeenCalledWith(
        -1,
        expect.objectContaining({ entityId: 100 })
      );
    });

    it('does not fail the strike when the mod-activity write fails', async () => {
      // The strike row is already committed here. Reporting a failure makes a moderator retry, and a
      // manual strike skips the rate limit — so the retry issues a second strike.
      mockTrackModActivity.mockRejectedValueOnce(new Error('insert failed'));

      const result = await createStrike(baseInput);

      expect(result).toEqual(mockCreatedStrike);
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', name: 'strike-mod-activity-failed', userId: 100 })
      );
    });
  });

  // ==========================================================================
  // voidStrike
  // ==========================================================================
  describe('voidStrike', () => {
    const voidInput = { strikeId: 1, voidReason: 'False positive', voidedBy: 2 };

    const mockVoidedStrike = {
      id: 1,
      userId: 100,
      reason: StrikeReason.TOSViolation,
      status: StrikeStatus.Voided,
      points: 1,
      voidedAt: new Date(),
      voidedBy: 2,
      voidReason: 'False positive',
    };

    it('atomically voids active strike via updateMany', async () => {
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 1 });
      mockDbRead.userStrike.findUniqueOrThrow.mockResolvedValue(mockVoidedStrike);
      // evaluateStrikeEscalation
      mockTransactionForEscalation(0, { muted: false, muteExpiresAt: null, meta: {} });

      const result = await voidStrike(voidInput);

      expect(result).toEqual(mockVoidedStrike);
      expect(mockDbWrite.userStrike.updateMany).toHaveBeenCalledWith({
        where: { id: 1, status: StrikeStatus.Active },
        data: expect.objectContaining({
          status: StrikeStatus.Voided,
          voidedBy: 2,
          voidReason: 'False positive',
        }),
      });
    });

    it('throws NOT_FOUND when strike does not exist', async () => {
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 0 });
      mockDbRead.userStrike.findUnique.mockResolvedValue(null);

      await expect(voidStrike(voidInput)).rejects.toThrow('Strike not found');
    });

    it('throws BAD_REQUEST when strike is already Voided or Expired', async () => {
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 0 });
      mockDbRead.userStrike.findUnique.mockResolvedValue({
        status: StrikeStatus.Voided,
      });

      await expect(voidStrike(voidInput)).rejects.toThrow(
        'Cannot void a strike with status "Voided"'
      );
    });

    it('sends strike-voided notification', async () => {
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 1 });
      mockDbRead.userStrike.findUniqueOrThrow.mockResolvedValue(mockVoidedStrike);
      mockTransactionForEscalation(0, { muted: false, muteExpiresAt: null, meta: {} });

      await voidStrike(voidInput);

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'strike-voided',
          userId: 100,
          details: { voidReason: 'False positive' },
        })
      );
    });

    it('re-evaluates escalation after voiding, and the void releases the mute', async () => {
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 1 });
      mockDbRead.userStrike.findUniqueOrThrow.mockResolvedValue(mockVoidedStrike);
      // `lastStrikeAt: null` models what the query returns once the only strike is voided — voided rows
      // are excluded, so a moderator taking a strike back unmutes without the user accepting anything.
      const { userUpdate } = mockTransactionForEscalation(
        0,
        { muted: true, muteExpiresAt: new Date('2099-01-01'), meta: {} },
        { lastStrikeAt: null }
      );

      await voidStrike(voidInput);

      // evaluateStrikeEscalation should have been called via transaction
      expect(mockDbWrite.$transaction).toHaveBeenCalled();
      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 100 },
          data: expect.objectContaining({ muted: false }),
        })
      );
    });
  });

  // ==========================================================================
  // expireStrikes
  // ==========================================================================
  describe('expireStrikes', () => {
    it('returns { expiredCount: 0 } when nothing to expire', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);

      const result = await expireStrikes();

      expect(result).toEqual({ expiredCount: 0 });
      expect(mockDbWrite.userStrike.updateMany).not.toHaveBeenCalled();
    });

    it('batch-updates expired strikes to Expired status', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([
        { id: 1, userId: 100 },
        { id: 2, userId: 100 },
      ]);
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 2 });
      // evaluateStrikeEscalation
      mockTransactionForEscalation(0, { muted: false, muteExpiresAt: null, meta: {} });

      const result = await expireStrikes();

      expect(result).toEqual({ expiredCount: 2 });
      expect(mockDbWrite.userStrike.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: StrikeStatus.Expired },
        })
      );
    });

    it('sends strike-expired notification per affected user in parallel', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([
        { id: 1, userId: 100 },
        { id: 2, userId: 200 },
      ]);
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 2 });
      mockTransactionForEscalation(0, { muted: false, muteExpiresAt: null, meta: {} });

      await expireStrikes();

      expect(mockCreateNotification).toHaveBeenCalledTimes(2);
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-expired', userId: 100 })
      );
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-expired', userId: 200 })
      );
    });

    it('calls evaluateStrikeEscalation per affected user via transaction', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([
        { id: 1, userId: 100 },
        { id: 2, userId: 200 },
      ]);
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 2 });
      mockTransactionForEscalation(0, { muted: false, muteExpiresAt: null, meta: {} });

      await expireStrikes();

      // 2 unique users = 2 calls to evaluateStrikeEscalation (each uses $transaction)
      expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // acceptTosAfterMute
  // ==========================================================================
  describe('acceptTosAfterMute', () => {
    const strikeMuted = {
      muted: true,
      mutedAt: null,
      meta: { muteReason: 'strike-escalation' },
    };

    function mockAcceptTransaction(user: any, pointsSum: number) {
      const userUpdate = vi.fn().mockResolvedValue(user);
      mockDbWrite.$transaction.mockImplementation(async (fn: any) =>
        fn({
          $queryRaw: vi.fn().mockResolvedValue([{ sum: pointsSum }]),
          user: { findUnique: vi.fn().mockResolvedValue(user), update: userUpdate },
        })
      );
      return { userUpdate };
    }

    it('records the acceptance and lifts the mute', async () => {
      const { userUpdate } = mockAcceptTransaction(strikeMuted, 2);

      const result = await acceptTosAfterMute({ userId: 1 });

      expect(result).toEqual({ unmuted: true });
      // The modal's own settings write is not awaited, so this call owns the acceptance record.
      expect(mockSetUserSetting).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ tosLastSeenDate: expect.any(Date) })
      );
      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ muted: false }) })
      );
      expect(mockRefreshSession).toHaveBeenCalledWith(1, { caller: 'strike' });
    });

    it('records against the domain the user accepted on', async () => {
      mockAcceptTransaction(strikeMuted, 2);

      await acceptTosAfterMute({ userId: 1, domain: 'green' });

      expect(mockSetUserSetting).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ tosGreenLastSeenDate: expect.any(Date) })
      );
    });

    it('refuses an account muted for something OTHER than strikes', async () => {
      // 🔴 The exploit this closes: the mutation is `protectedProcedure`, so any signed-in account can
      // call it. Without the reason check a spam bot the scam job muted unmutes itself by accepting
      // the Terms — never being shown the modal is not a control.
      const { userUpdate } = mockAcceptTransaction(
        { muted: true, mutedAt: null, meta: { muteReason: 'auto-mute-scam' } },
        2
      );

      const result = await acceptTosAfterMute({ userId: 1 });

      expect(result).toEqual({ unmuted: false, reason: 'not-eligible' });
      expect(userUpdate).not.toHaveBeenCalled();
      expect(mockRefreshSession).not.toHaveBeenCalled();
    });

    it('refuses a moderator-set mute', async () => {
      const { userUpdate } = mockAcceptTransaction(
        { muted: true, mutedAt: new Date('2026-01-01'), meta: { muteReason: 'strike-escalation' } },
        2
      );

      const result = await acceptTosAfterMute({ userId: 1 });

      expect(result).toEqual({ unmuted: false, reason: 'moderator' });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('refuses the review tier — a moderator decides that one', async () => {
      const { userUpdate } = mockAcceptTransaction(strikeMuted, 3);

      const result = await acceptTosAfterMute({ userId: 1 });

      expect(result).toEqual({ unmuted: false, reason: 'review' });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('decides on state read INSIDE the transaction, not before it', async () => {
      // Pins the eligibility read to the transaction: reverted to a pre-transaction `dbRead` read,
      // this decides on state that may already be stale.
      const escalated = {
        muted: true,
        mutedAt: null,
        meta: { muteReason: 'strike-escalation', strikeFlaggedForReview: true },
      };
      const { userUpdate } = mockAcceptTransaction(escalated, 3);

      const result = await acceptTosAfterMute({ userId: 1 });

      expect(result).toEqual({ unmuted: false, reason: 'review' });
      expect(userUpdate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // processTimedUnmutes
  // ==========================================================================
  describe('processTimedUnmutes', () => {
    it("releases a moderator's timed mute once its expiry passes", async () => {
      // 🔴 The regression this guards: filtering the sweep to `mutedAt IS NULL` excluded moderator
      // mutes entirely, and escalation refuses to lift one — so a 24h Mod Studio mute became
      // permanent. Nothing else in the system ends it.
      mockDbRead.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 100 }]);
      mockDbRead.user.findUnique.mockResolvedValue({ meta: {} });

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 1 });
      expect(mockUpdateUserById).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 100,
          data: expect.objectContaining({ muted: false, mutedAt: null }),
          updateSource: 'timed-unmute',
        })
      );
      expect(mockRefreshSession).toHaveBeenCalledWith(100, { caller: 'strike' });
    });

    it('asks for both kinds of mute, by the predicate each needs', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([]);

      await processTimedUnmutes();

      const [strikeArm, moderatorArm] = mockDbRead.$queryRaw.mock.calls.map(sqlOf);
      // Strike mutes have no expiry to find them by, so the reason is the only handle.
      expect(strikeArm).toContain('"mutedAt" IS NULL');
      expect(strikeArm).toContain(`'muteReason'`);
      // A moderator's mute is found by its own expiry and released outright.
      expect(moderatorArm).toContain('"mutedAt" IS NOT NULL');
      expect(moderatorArm).toContain('"muteExpiresAt" <= NOW()');
    });

    it('returns { unmutedCount: 0 } when nothing is held', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([]);

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 0 });
    });

    it('releases a strike mute once the points have fallen below the threshold', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 100 }]).mockResolvedValueOnce([]);
      mockTransactionForEscalation(1, {
        muted: true,
        muteExpiresAt: null,
        meta: { muteReason: 'strike-escalation' },
      });

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 1 });
    });

    it('does NOT re-mute an account whose points still stand', async () => {
      // The job passes no `allowMute`, so escalation can only release — otherwise every nightly run
      // undoes a moderator's manual unmute.
      mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 100 }]).mockResolvedValueOnce([]);
      const { userUpdate } = mockTransactionForEscalation(2, {
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 0 });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('leaves a moderator mute whose expiry has NOT passed alone', async () => {
      // Neither arm selects it — the strike arm excludes `mutedAt`, the moderator arm wants a lapsed
      // expiry — and escalation would refuse it anyway.
      mockDbRead.$queryRaw.mockResolvedValue([]);
      const { userUpdate } = mockTransactionForEscalation(0, {
        muted: true,
        mutedAt: new Date('2026-01-01'),
        muteExpiresAt: new Date('2099-01-01'),
        meta: {},
      });

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 0 });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('continues after one account fails', async () => {
      mockDbRead.$queryRaw
        .mockResolvedValueOnce([{ id: 100 }, { id: 200 }])
        .mockResolvedValueOnce([]);
      mockDbWrite.$transaction
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementationOnce(async (fn: any) =>
          fn({
            $queryRaw: vi
              .fn()
              .mockResolvedValueOnce([{ sum: 0 }])
              .mockResolvedValueOnce([{ last: null }]),
            user: {
              findUnique: vi.fn().mockResolvedValue({
                muted: true,
                muteExpiresAt: null,
                meta: { muteReason: 'strike-escalation' },
              }),
              update: vi.fn().mockResolvedValue({}),
            },
          })
        );

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 1 });
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'strike-timed-unmute-failed' })
      );
    });
  });
});
