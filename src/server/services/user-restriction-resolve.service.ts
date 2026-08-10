import { refreshSession } from '~/server/auth/session-invalidation';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { moderationActionEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { createNotification } from '~/server/services/notification.service';
import { resetProhibitedRequestCount } from '~/server/services/orchestrator/promptAuditing';
import { cancelSubscription, reinstateSubscription } from '~/server/services/stripe.service';
import { updateUserById } from '~/server/services/user.service';
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
    await updateUserById({
      id: restriction.userId,
      data: { muted: false },
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
  }).catch();

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
  | { unmuted: false; skipped: 'no-pending-restriction' };

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
