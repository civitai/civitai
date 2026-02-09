import { Prisma } from '@prisma/client';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { invalidateSession, refreshSession } from '~/server/auth/session-invalidation';
import { createNotification } from '~/server/services/notification.service';
import { updateUserById } from '~/server/services/user.service';
import { strikeIssuedEmail } from '~/server/email/templates';
import type { CreateStrikeInput, GetStrikesInput, VoidStrikeInput } from '~/server/schema/strike.schema';
import type { UserMeta } from '~/server/schema/user.schema';
import { StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';
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
 * Get strikes for a specific user.
 */
export async function getStrikesForUser(
  userId: number,
  opts?: { includeExpired?: boolean }
) {
  const { includeExpired = false } = opts ?? {};

  const strikes = await dbRead.userStrike.findMany({
    where: {
      userId,
      ...(!includeExpired && { status: StrikeStatus.Active }),
    },
    include: {
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
  const nextExpiry = activeStrikes.length > 0
    ? activeStrikes.reduce((earliest, s) =>
        s.expiresAt < earliest ? s.expiresAt : earliest, activeStrikes[0].expiresAt)
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

export type EscalationAction = 'none' | 'muted' | 'muted-and-flagged';

/**
 * Evaluate strike escalation for a user based on their total active points.
 * - 2 points: 3-day mute (timer resets/extends each time)
 * - 3+ points: Indefinite mute + flagged for review
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

    await createNotification({
      type: 'strike-escalation-muted',
      category: NotificationCategory.System,
      key: `strike-escalation-muted:${userId}:${Date.now()}`,
      userId,
      details: { muteDays: 'indefinite' },
    });

    await invalidateSession(userId);

    return { totalPoints, action: 'muted-and-flagged' };
  } else if (totalPoints >= 2) {
    // 3-day mute (always reset/extend timer)
    const muteExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    await updateUserById({
      id: userId,
      data: {
        muted: true,
        muteExpiresAt,
      },
      updateSource: 'strike-escalation',
    });

    await createNotification({
      type: 'strike-escalation-muted',
      category: NotificationCategory.System,
      key: `strike-escalation-muted:${userId}:${Date.now()}`,
      userId,
      details: { muteDays: 3 },
    });

    await invalidateSession(userId);

    return { totalPoints, action: 'muted' };
  }

  return { totalPoints, action: 'none' };
}

// ============================================================================
// CRUD Functions
// ============================================================================

/**
 * Create a new strike for a user.
 */
export async function createStrike(
  input: CreateStrikeInput & { issuedBy?: number }
) {
  const { userId, reason, points, description, internalNotes, entityType, entityId, reportId, expiresInDays, issuedBy } = input;

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

  // Send in-app notification
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

  // Send email if user has an email address
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

  return strike;
}

/**
 * Void an existing strike.
 */
export async function voidStrike(
  input: VoidStrikeInput & { voidedBy: number }
) {
  const { strikeId, voidReason, voidedBy } = input;

  // Update the strike
  const strike = await dbWrite.userStrike.update({
    where: { id: strikeId },
    data: {
      status: StrikeStatus.Voided,
      voidedAt: new Date(),
      voidedBy,
      voidReason,
    },
  });

  // Send notification to user
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
  await evaluateStrikeEscalation(strike.userId);

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

  // Send notifications for each expired strike
  const uniqueUserIds = [...new Set(strikesToExpire.map((s) => s.userId))];
  await Promise.all(
    uniqueUserIds.map((userId) =>
      createNotification({
        type: 'strike-expired',
        category: NotificationCategory.System,
        key: `strike-expired:${userId}:${Date.now()}`,
        userId,
        details: {},
      })
    )
  );

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

  // Unmute each user and refresh their session
  await Promise.all(
    usersToUnmute.map(async ({ id }) => {
      await updateUserById({
        id,
        data: {
          muted: false,
          muteExpiresAt: null,
        },
        updateSource: 'timed-unmute',
      });
      await refreshSession(id);
    })
  );

  return { unmutedCount: usersToUnmute.length };
}
