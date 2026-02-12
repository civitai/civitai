import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { invalidateSession, refreshSession } from '~/server/auth/session-invalidation';
import { createNotification } from '~/server/services/notification.service';
import { updateUserById } from '~/server/services/user.service';
import { strikeIssuedEmail } from '~/server/email/templates';
import type {
  CreateStrikeInput,
  GetStrikesInput,
  VoidStrikeInput,
} from '~/server/schema/strike.schema';
import type { UserMeta } from '~/server/schema/user.schema';
import { StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';
import { logToAxiom } from '~/server/logging/client';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Check if an auto-strike should be skipped due to rate limiting.
 * Limits non-manual strikes to max 1 per day per user.
 */
export async function shouldRateLimitStrike(userId: number): Promise<boolean> {
  const [result] = await dbRead.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "createdAt" >= CURRENT_DATE
      AND "reason" != ${StrikeReason.ManualModAction}::"StrikeReason"
  `;
  return Number(result.count) >= 1;
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get the sum of active strike points for a user.
 */
export async function getActiveStrikePoints(userId: number): Promise<number> {
  const [result] = await dbRead.$queryRaw<[{ sum: bigint | null }]>`
    SELECT SUM(points) as sum
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "status" = ${StrikeStatus.Active}::"StrikeStatus"
      AND "expiresAt" > NOW()
  `;
  return Number(result.sum ?? 0);
}

/**
 * Get a lightweight summary of active strikes for a user.
 * Single query returning only the 3 scalar values the summary endpoint needs.
 */
export async function getStrikeSummary(userId: number) {
  const [result] = await dbRead.$queryRaw<
    [{ count: bigint; sum: bigint | null; next_expiry: Date | null }]
  >`
    SELECT
      COUNT(*) as count,
      SUM(points) as sum,
      MIN("expiresAt") as next_expiry
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "status" = ${StrikeStatus.Active}::"StrikeStatus"
      AND "expiresAt" > NOW()
  `;

  return {
    activeStrikes: Number(result.count),
    totalActivePoints: Number(result.sum ?? 0),
    nextExpiry: result.next_expiry,
  };
}

/**
 * Get strikes for a specific user.
 * @param includeInternalNotes - Only true for mod-facing queries. Users must NOT see internal notes.
 */
export async function getStrikesForUser(
  userId: number,
  opts?: { includeExpired?: boolean; includeInternalNotes?: boolean }
) {
  const { includeExpired = false, includeInternalNotes = false } = opts ?? {};

  const strikes = await dbRead.userStrike.findMany({
    where: {
      userId,
      ...(!includeExpired && { status: StrikeStatus.Active }),
    },
    select: {
      id: true,
      userId: true,
      reason: true,
      status: true,
      points: true,
      description: true,
      internalNotes: includeInternalNotes,
      entityType: true,
      entityId: true,
      reportId: true,
      createdAt: true,
      expiresAt: true,
      voidedAt: true,
      voidedBy: true,
      voidReason: true,
      issuedBy: true,
      issuedByUser: {
        select: { id: true, username: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const totalActivePoints = await getActiveStrikePoints(userId);

  // Find the next expiry date for active strikes
  const activeStrikes = strikes.filter(
    (s) => s.status === StrikeStatus.Active && s.expiresAt > new Date()
  );
  const nextExpiry =
    activeStrikes.length > 0
      ? activeStrikes.reduce(
          (earliest, s) => (s.expiresAt < earliest ? s.expiresAt : earliest),
          activeStrikes[0].expiresAt
        )
      : null;

  return { strikes, totalActivePoints, nextExpiry };
}

/**
 * Get paginated strikes for moderator dashboard.
 */
export async function getStrikesForMod(input: GetStrikesInput) {
  const { limit, page, userId, username, status, reason } = input;
  const { take, skip } = getPagination(limit, page);

  // If username provided, look up the user first
  let targetUserId = userId;
  if (username && !userId) {
    const user = await dbRead.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    });
    targetUserId = user?.id;
    // If username doesn't match any user, return empty results
    if (!targetUserId) {
      return getPagingData({ items: [], count: 0 }, take, page);
    }
  }

  const where: Prisma.UserStrikeWhereInput = {
    ...(targetUserId && { userId: targetUserId }),
    ...(status && { status }),
    ...(reason && { reason }),
  };

  const [items, count] = await Promise.all([
    dbRead.userStrike.findMany({
      where,
      include: {
        user: {
          select: { id: true, username: true },
        },
        issuedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    }),
    dbRead.userStrike.count({ where }),
  ]);

  return getPagingData({ items, count }, take, page);
}

// ============================================================================
// Escalation Engine
// ============================================================================

export type EscalationAction = 'none' | 'muted' | 'muted-and-flagged' | 'unmuted';

/**
 * Evaluate strike escalation for a user based on their total active points.
 * Handles both escalation (mute/flag) and de-escalation (unmute when points drop).
 * - 3+ points: Indefinite mute + flagged for review
 * - 2 points: 3-day mute (timer resets/extends each time)
 * - <2 points: If currently strike-muted, unmute and clear flag
 */
export async function evaluateStrikeEscalation(
  userId: number
): Promise<{ totalPoints: number; action: EscalationAction }> {
  const totalPoints = await getActiveStrikePoints(userId);

  // Get current user state
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: { muted: true, muteExpiresAt: true, meta: true },
  });

  if (!user) {
    return { totalPoints, action: 'none' };
  }

  const currentMeta = (user.meta as UserMeta) ?? {};

  if (totalPoints >= 3) {
    // Indefinite mute + flag for review
    const alreadyFlagged = user.muted && currentMeta.strikeFlaggedForReview;

    await updateUserById({
      id: userId,
      data: {
        muted: true,
        muteExpiresAt: null, // Indefinite
        meta: {
          ...currentMeta,
          strikeFlaggedForReview: true,
          strikeFlaggedAt: new Date(),
        },
      },
      updateSource: 'strike-escalation',
    });

    // Only send notification if this is a new escalation, not a duplicate
    if (!alreadyFlagged) {
      await createNotification({
        type: 'strike-escalation-muted',
        category: NotificationCategory.System,
        key: `strike-escalation-muted:${userId}:${Date.now()}`,
        userId,
        details: { muteDays: 'indefinite' },
      });
    }

    await invalidateSession(userId);

    return { totalPoints, action: 'muted-and-flagged' };
  } else if (totalPoints >= 2) {
    // 3-day mute (always reset/extend timer)
    const muteExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const alreadyTimedMuted = user.muted && user.muteExpiresAt !== null;

    await updateUserById({
      id: userId,
      data: {
        muted: true,
        muteExpiresAt,
        // Clear the review flag if points dropped below 3
        ...(currentMeta.strikeFlaggedForReview && {
          meta: {
            ...currentMeta,
            strikeFlaggedForReview: false,
          },
        }),
      },
      updateSource: 'strike-escalation',
    });

    // Only send notification if this is a new mute, not just extending an existing one
    if (!alreadyTimedMuted) {
      await createNotification({
        type: 'strike-escalation-muted',
        category: NotificationCategory.System,
        key: `strike-escalation-muted:${userId}:${Date.now()}`,
        userId,
        details: { muteDays: 3 },
      });
    }

    await invalidateSession(userId);

    return { totalPoints, action: 'muted' };
  }

  // De-escalation: if user is currently muted from strikes, unmute them.
  // Only unmute if the mute was from strikes (has muteExpiresAt set) or
  // was flagged for review. Don't touch manual mutes (muteExpiresAt === null
  // and no strike flag).
  if (user.muted && (user.muteExpiresAt !== null || currentMeta.strikeFlaggedForReview)) {
    await updateUserById({
      id: userId,
      data: {
        muted: false,
        muteExpiresAt: null,
        ...(currentMeta.strikeFlaggedForReview && {
          meta: {
            ...currentMeta,
            strikeFlaggedForReview: false,
          },
        }),
      },
      updateSource: 'strike-de-escalation',
    });

    await createNotification({
      type: 'strike-de-escalation-unmuted',
      category: NotificationCategory.System,
      key: `strike-de-escalation-unmuted:${userId}:${Date.now()}`,
      userId,
      details: {},
    });

    await refreshSession(userId);
    return { totalPoints, action: 'unmuted' };
  }

  return { totalPoints, action: 'none' };
}

// ============================================================================
// CRUD Functions
// ============================================================================

/**
 * Create a new strike for a user.
 */
export async function createStrike(input: CreateStrikeInput & { issuedBy?: number }) {
  const {
    userId,
    reason,
    points,
    description,
    internalNotes,
    entityType,
    entityId,
    reportId,
    expiresInDays,
    issuedBy,
  } = input;

  // Validate user exists
  const userExists = await dbRead.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!userExists) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `User ${userId} not found` });
  }

  // Rate limit check for non-manual strikes
  if (reason !== StrikeReason.ManualModAction) {
    const shouldLimit = await shouldRateLimitStrike(userId);
    if (shouldLimit) {
      // Skip creating the strike but don't throw an error
      return null;
    }
  }

  // Calculate expiration date
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  // Create the strike record
  const strike = await dbWrite.userStrike.create({
    data: {
      userId,
      reason,
      points,
      description,
      internalNotes,
      entityType,
      entityId,
      reportId,
      expiresAt,
      issuedBy,
    },
  });

  // Evaluate escalation after creating the strike
  await evaluateStrikeEscalation(userId);

  // Get updated active points for notification/email
  const activePoints = await getActiveStrikePoints(userId);

  // Send notification — createNotification handles its own error logging
  await createNotification({
    type: 'strike-issued',
    category: NotificationCategory.System,
    key: `strike-issued:${userId}:${strike.id}`,
    userId,
    details: {
      description,
      points,
    },
  });

  try {
    const user = await dbRead.user.findUnique({
      where: { id: userId },
      select: { email: true, username: true },
    });

    if (user?.email) {
      await strikeIssuedEmail.send({
        to: user.email,
        username: user.username ?? 'User',
        reason,
        description,
        points,
        activePoints,
        expiresAt,
      });
    }
  } catch (error) {
    const err = error as Error;
    logToAxiom({
      type: 'error',
      name: 'strike-email-failed',
      message: err.message,
      stack: err.stack,
      userId,
      strikeId: strike.id,
    });
  }

  return strike;
}

/**
 * Void an existing strike.
 * Uses atomic updateMany with status guard to prevent race conditions.
 */
export async function voidStrike(input: VoidStrikeInput & { voidedBy: number }) {
  const { strikeId, voidReason, voidedBy } = input;

  // Atomic update: only void if currently Active (prevents race conditions)
  const { count } = await dbWrite.userStrike.updateMany({
    where: { id: strikeId, status: StrikeStatus.Active },
    data: {
      status: StrikeStatus.Voided,
      voidedAt: new Date(),
      voidedBy,
      voidReason,
    },
  });

  if (count === 0) {
    // Determine why: not found vs wrong status
    const existing = await dbRead.userStrike.findUnique({
      where: { id: strikeId },
      select: { status: true },
    });
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Strike not found' });
    }
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot void a strike with status "${existing.status}". Only active strikes can be voided.`,
    });
  }

  // Fetch the updated strike for return value and userId
  const strike = await dbRead.userStrike.findUniqueOrThrow({
    where: { id: strikeId },
  });

  // Send notification — createNotification handles its own error logging
  await createNotification({
    type: 'strike-voided',
    category: NotificationCategory.System,
    key: `strike-voided:${strike.userId}:${strike.id}`,
    userId: strike.userId,
    details: {
      voidReason,
    },
  });

  // Re-evaluate escalation (may de-escalate)
  try {
    await evaluateStrikeEscalation(strike.userId);
  } catch (error) {
    const err = error as Error;
    logToAxiom({
      type: 'error',
      name: 'strike-void-escalation-failed',
      message: err.message,
      stack: err.stack,
      userId: strike.userId,
      strikeId: strike.id,
    });
  }

  return strike;
}

// ============================================================================
// Job Functions
// ============================================================================

/**
 * Expire strikes that have passed their expiration date.
 */
export async function expireStrikes(): Promise<{ expiredCount: number }> {
  // Get strikes that need to expire (for notifications)
  const strikesToExpire = await dbRead.userStrike.findMany({
    where: {
      status: StrikeStatus.Active,
      expiresAt: { lte: new Date() },
    },
    select: { id: true, userId: true },
  });

  if (strikesToExpire.length === 0) {
    return { expiredCount: 0 };
  }

  // Batch update all expired strikes
  await dbWrite.userStrike.updateMany({
    where: {
      status: StrikeStatus.Active,
      expiresAt: { lte: new Date() },
    },
    data: {
      status: StrikeStatus.Expired,
    },
  });

  // Send notifications and re-evaluate escalation for affected users
  const uniqueUserIds = [...new Set(strikesToExpire.map((s) => s.userId))];
  for (const userId of uniqueUserIds) {
    // createNotification handles its own error logging
    await createNotification({
      type: 'strike-expired',
      category: NotificationCategory.System,
      key: `strike-expired:${userId}:${Date.now()}`,
      userId,
      details: {},
    });

    // Re-evaluate escalation — may de-escalate (unmute) if points dropped below threshold
    try {
      await evaluateStrikeEscalation(userId);
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'strike-expired-escalation-failed',
        message: err.message,
        stack: err.stack,
        userId,
      });
    }
  }

  return { expiredCount: strikesToExpire.length };
}

/**
 * Process timed mutes that have expired.
 */
export async function processTimedUnmutes(): Promise<{ unmutedCount: number }> {
  // Find users whose timed mute has expired
  const usersToUnmute = await dbRead.user.findMany({
    where: {
      muted: true,
      muteExpiresAt: {
        not: null,
        lte: new Date(),
      },
    },
    select: { id: true },
  });

  if (usersToUnmute.length === 0) {
    return { unmutedCount: 0 };
  }

  // Re-evaluate escalation for each user before unmuting.
  // If they still have >= 2 active strike points, they should stay muted.
  let unmutedCount = 0;
  for (const { id } of usersToUnmute) {
    try {
      const { action } = await evaluateStrikeEscalation(id);

      // evaluateStrikeEscalation handles re-muting if points are still high.
      // Only manually unmute if escalation returned 'none' (points < 2) or 'unmuted'.
      if (action === 'none') {
        await updateUserById({
          id,
          data: {
            muted: false,
            muteExpiresAt: null,
          },
          updateSource: 'timed-unmute',
        });
        await refreshSession(id);
        unmutedCount++;
      } else if (action === 'unmuted') {
        // evaluateStrikeEscalation already unmuted them
        unmutedCount++;
      }
      // If action is 'muted' or 'muted-and-flagged', escalation re-applied the mute
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'strike-timed-unmute-failed',
        message: err.message,
        stack: err.stack,
        userId: id,
      });
    }
  }

  return { unmutedCount };
}
