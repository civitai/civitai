import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define mocks that will be available in vi.mock factories
const {
  mockDbRead,
  mockDbWrite,
  mockCreateNotification,
  mockUpdateUserById,
  mockInvalidateSession,
  mockRefreshSession,
  mockStrikeIssuedEmailSend,
} = vi.hoisted(() => {
  const mockUserStrikeRead = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
  };

  const mockUserStrikeWrite = {
    create: vi.fn(),
    updateMany: vi.fn(),
  };

  const mockUserRead = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  };

  return {
    mockDbRead: {
      userStrike: mockUserStrikeRead,
      user: mockUserRead,
      $queryRaw: vi.fn(),
    },
    mockDbWrite: {
      userStrike: mockUserStrikeWrite,
    },
    mockCreateNotification: vi.fn().mockResolvedValue(undefined),
    mockUpdateUserById: vi.fn().mockResolvedValue(undefined),
    mockInvalidateSession: vi.fn().mockResolvedValue(undefined),
    mockRefreshSession: vi.fn().mockResolvedValue(undefined),
    mockStrikeIssuedEmailSend: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock modules
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/services/user.service', () => ({
  updateUserById: mockUpdateUserById,
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
  evaluateStrikeEscalation,
  createStrike,
  voidStrike,
  expireStrikes,
  processTimedUnmutes,
} from '~/server/services/strike.service';
import { StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';

describe('strike.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 1 }]);

      const result = await getStrikesForUser(100);

      expect(result.strikes).toHaveLength(1);
      expect(result.totalActivePoints).toBe(1);
      expect(result.nextExpiry).toEqual(new Date('2099-01-01'));
    });

    it('filters to Active-only by default (includeExpired: false)', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: null }]);

      await getStrikesForUser(100);

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 100, status: StrikeStatus.Active },
        })
      );
    });

    it('includes all statuses when includeExpired: true', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: null }]);

      await getStrikesForUser(100, { includeExpired: true });

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 100 },
        })
      );
    });

    it('select.internalNotes is true when includeInternalNotes: true', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: null }]);

      await getStrikesForUser(100, { includeInternalNotes: true });

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ internalNotes: true }),
        })
      );
    });

    it('select.internalNotes is false when includeInternalNotes: false', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([]);
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: null }]);

      await getStrikesForUser(100, { includeInternalNotes: false });

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ internalNotes: false }),
        })
      );
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
        status: StrikeStatus.Active,
        reason: StrikeReason.TOSViolation,
      });

      expect(mockDbRead.userStrike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 1,
            status: StrikeStatus.Active,
            reason: StrikeReason.TOSViolation,
          }),
        })
      );
    });
  });

  // ==========================================================================
  // evaluateStrikeEscalation
  // ==========================================================================
  describe('evaluateStrikeEscalation', () => {
    it('3+ points: mutes, flags for review, invalidates session', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 3 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result).toEqual({ totalPoints: 3, action: 'muted-and-flagged' });
      expect(mockUpdateUserById).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          data: expect.objectContaining({
            muted: true,
            muteExpiresAt: null,
            meta: expect.objectContaining({ strikeFlaggedForReview: true }),
          }),
        })
      );
      expect(mockInvalidateSession).toHaveBeenCalledWith(1);
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-escalation-muted' })
      );
    });

    it('3+ points, already flagged: updates user but skips duplicate notification', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 4 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: null,
        meta: { strikeFlaggedForReview: true },
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result.action).toBe('muted-and-flagged');
      expect(mockUpdateUserById).toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('2 points: 3-day mute, invalidates session', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 2 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result).toEqual({ totalPoints: 2, action: 'muted' });
      expect(mockUpdateUserById).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          data: expect.objectContaining({
            muted: true,
            muteExpiresAt: expect.any(Date),
          }),
        })
      );
      expect(mockInvalidateSession).toHaveBeenCalledWith(1);
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'strike-escalation-muted',
          details: { muteDays: 3 },
        })
      );
    });

    it('2 points, already timed-muted: updates user but skips duplicate notification', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 2 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: new Date('2099-01-01'),
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result.action).toBe('muted');
      expect(mockUpdateUserById).toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('2 points with existing flag: clears strikeFlaggedForReview', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 2 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: null,
        meta: { strikeFlaggedForReview: true },
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result.action).toBe('muted');
      expect(mockUpdateUserById).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            meta: expect.objectContaining({ strikeFlaggedForReview: false }),
          }),
        })
      );
    });

    it('<2 points, user not muted: no action', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 1 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result).toEqual({ totalPoints: 1, action: 'none' });
      expect(mockUpdateUserById).not.toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('<2 points, user strike-muted (has muteExpiresAt): unmutes and sends notification', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 1 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: new Date('2099-01-01'),
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result).toEqual({ totalPoints: 1, action: 'unmuted' });
      expect(mockUpdateUserById).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            muted: false,
            muteExpiresAt: null,
          }),
          updateSource: 'strike-de-escalation',
        })
      );
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-de-escalation-unmuted' })
      );
      expect(mockRefreshSession).toHaveBeenCalledWith(1);
    });

    it('<2 points, user flagged (has strikeFlaggedForReview): unmutes and clears flag', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: null,
        meta: { strikeFlaggedForReview: true },
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result).toEqual({ totalPoints: 0, action: 'unmuted' });
      expect(mockUpdateUserById).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            muted: false,
            muteExpiresAt: null,
            meta: expect.objectContaining({ strikeFlaggedForReview: false }),
          }),
        })
      );
    });

    it('<2 points, user manually muted (no muteExpiresAt, no flag): does NOT unmute', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await evaluateStrikeEscalation(1);

      expect(result).toEqual({ totalPoints: 0, action: 'none' });
      expect(mockUpdateUserById).not.toHaveBeenCalled();
    });

    it('user not found: returns none', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 3 }]);
      mockDbRead.user.findUnique.mockResolvedValue(null);

      const result = await evaluateStrikeEscalation(999);

      expect(result).toEqual({ totalPoints: 3, action: 'none' });
      expect(mockUpdateUserById).not.toHaveBeenCalled();
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
        .mockResolvedValueOnce({ muted: false, muteExpiresAt: null, meta: {} }) // evaluateStrikeEscalation
        .mockResolvedValueOnce({ email: 'user@test.com', username: 'testuser' }); // email lookup
      mockDbRead.$queryRaw
        .mockResolvedValueOnce([{ count: 0 }]) // shouldRateLimitStrike
        .mockResolvedValueOnce([{ sum: 1 }]) // evaluateStrikeEscalation -> getActiveStrikePoints
        .mockResolvedValueOnce([{ sum: 1 }]); // getActiveStrikePoints for notification
      mockDbWrite.userStrike.create.mockResolvedValue(mockCreatedStrike);
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

    it('bypasses rate limit for ManualModAction', async () => {
      const manualInput = { ...baseInput, reason: StrikeReason.ManualModAction };

      // Reset and set up for manual action (no rate limit call)
      mockDbRead.$queryRaw.mockReset();
      mockDbRead.$queryRaw
        .mockResolvedValueOnce([{ sum: 1 }]) // evaluateStrikeEscalation -> getActiveStrikePoints
        .mockResolvedValueOnce([{ sum: 1 }]); // getActiveStrikePoints for notification

      mockDbRead.user.findUnique.mockReset();
      mockDbRead.user.findUnique
        .mockResolvedValueOnce({ id: 100 }) // user exists
        .mockResolvedValueOnce({ muted: false, muteExpiresAt: null, meta: {} }) // escalation
        .mockResolvedValueOnce({ email: 'user@test.com', username: 'testuser' }); // email

      const result = await createStrike(manualInput);

      expect(result).toEqual(mockCreatedStrike);
    });

    it('calls evaluateStrikeEscalation after creation', async () => {
      await createStrike(baseInput);

      // evaluateStrikeEscalation calls getActiveStrikePoints which uses $queryRaw,
      // and user.findUnique for user state
      expect(mockDbRead.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 100 },
          select: { muted: true, muteExpiresAt: true, meta: true },
        })
      );
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

    it('does not throw if notification fails', async () => {
      mockCreateNotification.mockRejectedValueOnce(new Error('Notification failed'));

      const result = await createStrike(baseInput);

      expect(result).toEqual(mockCreatedStrike);
    });

    it('does not throw if email fails', async () => {
      mockStrikeIssuedEmailSend.mockRejectedValueOnce(new Error('Email failed'));

      const result = await createStrike(baseInput);

      expect(result).toEqual(mockCreatedStrike);
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
      // evaluateStrikeEscalation mocks
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

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
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      await voidStrike(voidInput);

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'strike-voided',
          userId: 100,
          details: { voidReason: 'False positive' },
        })
      );
    });

    it('re-evaluates escalation after voiding', async () => {
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 1 });
      mockDbRead.userStrike.findUniqueOrThrow.mockResolvedValue(mockVoidedStrike);
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: new Date('2099-01-01'),
        meta: {},
      });

      await voidStrike(voidInput);

      // evaluateStrikeEscalation should have been called and unmuted the user
      expect(mockUpdateUserById).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 100,
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
      // evaluateStrikeEscalation mocks
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await expireStrikes();

      expect(result).toEqual({ expiredCount: 2 });
      expect(mockDbWrite.userStrike.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: StrikeStatus.Expired },
        })
      );
    });

    it('sends strike-expired notification per affected user', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([
        { id: 1, userId: 100 },
        { id: 2, userId: 200 },
      ]);
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 2 });
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      await expireStrikes();

      expect(mockCreateNotification).toHaveBeenCalledTimes(2);
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-expired', userId: 100 })
      );
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'strike-expired', userId: 200 })
      );
    });

    it('calls evaluateStrikeEscalation per affected user', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([
        { id: 1, userId: 100 },
        { id: 2, userId: 200 },
      ]);
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 2 });
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      await expireStrikes();

      // getActiveStrikePoints (via $queryRaw) should have been called for each unique user
      // 2 users = 2 calls to evaluateStrikeEscalation
      expect(mockDbRead.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 100 } })
      );
      expect(mockDbRead.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 200 } })
      );
    });

    it('does not crash if notification fails for one user', async () => {
      mockDbRead.userStrike.findMany.mockResolvedValue([
        { id: 1, userId: 100 },
        { id: 2, userId: 200 },
      ]);
      mockDbWrite.userStrike.updateMany.mockResolvedValue({ count: 2 });
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      // First notification fails
      mockCreateNotification
        .mockRejectedValueOnce(new Error('Notification failed'))
        .mockResolvedValueOnce(undefined);

      const result = await expireStrikes();

      // Should still complete and process the second user
      expect(result).toEqual({ expiredCount: 2 });
    });
  });

  // ==========================================================================
  // processTimedUnmutes
  // ==========================================================================
  describe('processTimedUnmutes', () => {
    it('returns { unmutedCount: 0 } when no users with expired mutes', async () => {
      mockDbRead.user.findMany.mockResolvedValue([]);

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 0 });
    });

    it('unmutes user when escalation returns none (points < 2)', async () => {
      mockDbRead.user.findMany.mockResolvedValue([{ id: 100 }]);
      // evaluateStrikeEscalation: points < 2, user not strike-muted (no muteExpiresAt, no flag)
      // -> returns 'none', so processTimedUnmutes manually unmutes
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 0 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: null, // evaluateStrikeEscalation sees this state after mute check
        meta: {},
      });

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 1 });
      expect(mockUpdateUserById).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 100,
          data: expect.objectContaining({ muted: false, muteExpiresAt: null }),
          updateSource: 'timed-unmute',
        })
      );
      expect(mockRefreshSession).toHaveBeenCalledWith(100);
    });

    it('counts user when escalation returns unmuted', async () => {
      mockDbRead.user.findMany.mockResolvedValue([{ id: 100 }]);
      // evaluateStrikeEscalation: points < 2, but user has muteExpiresAt set
      // -> escalation unmutes them itself and returns 'unmuted'
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 1 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: true,
        muteExpiresAt: new Date('2024-01-01'), // strike-based mute
        meta: {},
      });

      const result = await processTimedUnmutes();

      expect(result).toEqual({ unmutedCount: 1 });
    });

    it('does NOT unmute when escalation re-applies mute (points still >= 2)', async () => {
      mockDbRead.user.findMany.mockResolvedValue([{ id: 100 }]);
      // evaluateStrikeEscalation: points >= 2, re-applies mute -> returns 'muted'
      mockDbRead.$queryRaw.mockResolvedValue([{ sum: 2 }]);
      mockDbRead.user.findUnique.mockResolvedValue({
        muted: false,
        muteExpiresAt: null,
        meta: {},
      });

      const result = await processTimedUnmutes();

      // User should NOT be counted as unmuted
      expect(result).toEqual({ unmutedCount: 0 });
    });
  });
});
