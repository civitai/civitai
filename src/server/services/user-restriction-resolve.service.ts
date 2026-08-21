import { refreshSession } from '~/server/auth/session-invalidation';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { moderationActionEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { createNotification } from '~/server/services/notification.service';
import { resetProhibitedRequestCount } from '~/server/services/orchestrator/promptAuditing';
import { cancelSubscription, reinstateSubscription } from '~/server/services/stripe.service';
import { updateUserById } from '~/server/services/user.service';
import { clearedMuteFields } from '~/server/services/mute-provenance';
import { dbRead } from '~/server/db/client';
import type { UserMeta } from '~/server/schema/user.schema';
import { PROTECTED_USER_IDS } from '~/server/services/user-restriction.service';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';

/**
 * Uphold or overturn a generation restriction. The single write path for a
 * verdict — the moderator router and the service-facing overturn endpoint both
 * go through here so the membership and violation-count side effects can't drift.
 */
export async function resolveUserRestriction({
  userRestrictionId,
  status,
  resolvedMessage,
  moderatorId,
}: {
  userRestrictionId: number;
  status: UserRestrictionStatus;
  resolvedMessage?: string;
  moderatorId: number;
}) {
  const restriction = await dbWrite.userRestriction.findUnique({
    where: { id: userRestrictionId },
    select: {
      id: true,
      userId: true,
      status: true,
      user: { select: { email: true, username: true } },
    },
  });

  if (!restriction) throw new Error('Restriction record not found');
  if (restriction.status !== UserRestrictionStatus.Pending)
    throw new Error('Restriction has already been resolved');

  await dbWrite.userRestriction.update({
    where: { id: userRestrictionId },
    data: { status, resolvedAt: new Date(), resolvedBy: moderatorId, resolvedMessage },
  });

  if (status === UserRestrictionStatus.Upheld) {
    await updateUserById({
      id: restriction.userId,
      data: { mutedAt: new Date() },
      updateSource: 'moderator:generationRestrictionUpheld',
    });
    // Cancel at period end (reversible) rather than waiting for the daily
    // confirm-mutes safety-net job.
    await cancelSubscription({ userId: restriction.userId, atPeriodEnd: true }).catch((error) =>
      logToAxiom({
        name: 'cancel-stripe-subscription-restriction-upheld',
        type: 'error',
        message: (error as Error).message,
      })
    );
    await refreshSession(restriction.userId, { caller: 'moderation' });
  } else if (status === UserRestrictionStatus.Overturned) {
    // Overturning clears the whole mute, not just the flag: an uphold sets `mutedAt` (line above), and
    // leaving it behind on an overturn keeps the account off every leaderboard and makes the next
    // automatic mute read as a moderator's.
    const existing = await dbRead.user.findUnique({
      where: { id: restriction.userId },
      select: { meta: true },
    });
    await updateUserById({
      id: restriction.userId,
      data: clearedMuteFields(existing?.meta as UserMeta | null),
      updateSource: 'moderator:generationRestrictionOverturned',
    });
    await reinstateSubscription({ userId: restriction.userId }).catch((error) =>
      logToAxiom({
        name: 'reinstate-stripe-subscription-restriction-overturned',
        type: 'error',
        message: (error as Error).message,
      })
    );
    await resetProhibitedRequestCount(restriction.userId);
    await refreshSession(restriction.userId, { caller: 'moderation' });
  }

  const notifType =
    status === UserRestrictionStatus.Upheld
      ? 'generation-restriction-upheld'
      : 'generation-restriction-overturned';

  await createNotification({
    type: notifType,
    key: `${notifType}:${restriction.userId}:${userRestrictionId}`,
    category: NotificationCategory.System,
    userId: restriction.userId,
    details: { resolvedMessage: resolvedMessage ?? '' },
  }).catch((error) =>
    logToAxiom({
      name: 'restriction-resolved-notify-failed',
      type: 'error',
      message: (error as Error).message,
    })
  );

  try {
    if (restriction.user?.email) {
      // Moderator free-text is shown only in-app, never emailed, to avoid
      // forwarding potentially explicit or targeted prose.
      await moderationActionEmail.send({
        to: restriction.user.email,
        username: restriction.user.username ?? 'User',
        kind:
          status === UserRestrictionStatus.Upheld ? 'restriction-upheld' : 'restriction-overturned',
      });
    }
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'restriction-email-failed',
      message: (error as Error).message,
      error,
    });
  }

  logToAxiom({
    name: 'user-restriction-resolved',
    type: 'info',
    details: { userRestrictionId, status, moderatorId, userId: restriction.userId },
  });

  return { userId: restriction.userId };
}

export type OverturnPendingReviewMuteResult =
  | { unmuted: true; userRestrictionId: number }
  | {
      unmuted: false;
      skipped: 'protected' | 'moderator' | 'manually-muted' | 'no-pending-restriction';
    };

/**
 * Service-facing "they shouldn't have been muted": overturns the user's open
 * generation restriction so the review queue doesn't keep a stale Pending row,
 * and picks up the reinstate-subscription and violation-count reset with it.
 */
export async function overturnPendingReviewMute({
  userId,
  resolvedMessage,
  moderatorId,
}: {
  userId: number;
  resolvedMessage?: string;
  moderatorId: number;
}): Promise<OverturnPendingReviewMuteResult> {
  if (PROTECTED_USER_IDS.has(userId)) return { unmuted: false, skipped: 'protected' };

  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { isModerator: true, mutedAt: true },
  });
  if (!user) throw new Error(`No user with id ${userId}`);
  if (user.isModerator) return { unmuted: false, skipped: 'moderator' };
  // Only a moderator's verdict writes `mutedAt`, so a non-null value is a human
  // decision that no service caller may reverse.
  if (user.mutedAt) return { unmuted: false, skipped: 'manually-muted' };

  const restriction = await dbWrite.userRestriction.findFirst({
    where: { userId, type: 'generation', status: UserRestrictionStatus.Pending },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!restriction) return { unmuted: false, skipped: 'no-pending-restriction' };

  await resolveUserRestriction({
    userRestrictionId: restriction.id,
    status: UserRestrictionStatus.Overturned,
    resolvedMessage,
    moderatorId,
  });

  return { unmuted: true, userRestrictionId: restriction.id };
}
