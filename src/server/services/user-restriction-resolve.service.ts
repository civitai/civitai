import { refreshSession } from '~/server/auth/session-invalidation';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { moderationActionEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { createNotification } from '~/server/services/notification.service';
import { userUpdateCounter } from '~/server/prom/client';
import { resetProhibitedRequestCount } from '~/server/services/orchestrator/promptAuditing';
import { cancelSubscription, reinstateSubscription } from '~/server/services/stripe.service';
import { updateUserById } from '~/server/services/user.service';
import { clearedMuteFields } from '~/server/services/mute-provenance';
import { restoreScamCase } from '~/server/services/scam-cleanup.service';
import { voidScamCaseStrikes } from '~/server/services/scam-case-ledger';
import type { UserMeta } from '~/server/schema/user.schema';
import {
  hasOtherPendingRestriction,
  PROTECTED_USER_IDS,
  unwiredRulingReason,
  type UserRestrictionType,
} from '~/server/services/user-restriction.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';
import type { Prisma } from '@prisma/client';

export type RulingEffects = {
  upheldNotification: string;
  overturnedNotification: string;
  upheldSource: string;
  overturnedSource: string;
  overturnInTransaction?: (
    tx: Prisma.TransactionClient,
    restriction: { id: number; userId: number },
    moderatorId: number
  ) => Promise<unknown>;
  afterOverturn?: (restriction: { id: number; userId: number }) => Promise<unknown>;
};

export const RULING_EFFECTS: Partial<Record<UserRestrictionType, RulingEffects>> = {
  generation: {
    upheldNotification: 'generation-restriction-upheld',
    overturnedNotification: 'generation-restriction-overturned',
    upheldSource: 'moderator:generationRestrictionUpheld',
    overturnedSource: 'moderator:generationRestrictionOverturned',
    afterOverturn: ({ userId }) => resetProhibitedRequestCount(userId),
  },
  scam: {
    upheldNotification: 'review-restriction-upheld',
    overturnedNotification: 'review-restriction-overturned',
    upheldSource: 'moderator:scamRestrictionUpheld',
    overturnedSource: 'moderator:scamRestrictionOverturned',
    overturnInTransaction: (tx, { id }, moderatorId) =>
      voidScamCaseStrikes(
        [id],
        { voidedBy: moderatorId > 0 ? moderatorId : null, reason: 'Scam restriction overturned.' },
        tx
      ),
    afterOverturn: ({ id }) =>
      restoreScamCase(id).catch((error) =>
        logToAxiom({
          name: 'scam-restore-failed',
          type: 'error',
          message: (error as Error).message,
          details: { userRestrictionId: id },
        })
      ),
  },
};

/**
 * Uphold or overturn a restriction. The single write path for a
 * verdict — the moderator router and the service-facing overturn endpoint both
 * go through here so the membership and violation-count side effects can't drift.
 *
 * 🔴 Being the single write path is also why the type refusal lives here rather than at the routes.
 * Everything type-specific — notices, update sources and the overturn effect — comes from
 * `RULING_EFFECTS`; a type without an entry is refused. Every caller reaches it (the tRPC router,
 * `/api/mod/restriction/resolve`, `overturnPendingReviewMute`), and only one of them used to check.
 * See `unwiredRulingReason`.
 */
export async function resolveUserRestriction({
  userRestrictionId,
  status,
  resolvedMessage,
  resolvedReason,
  internalNotes,
  moderatorId,
}: {
  userRestrictionId: number;
  status: UserRestrictionStatus;
  resolvedMessage?: string;
  resolvedReason?: string;
  internalNotes?: string;
  moderatorId: number;
}) {
  const restriction = await dbWrite.userRestriction.findUnique({
    where: { id: userRestrictionId },
    select: {
      id: true,
      userId: true,
      status: true,
      // Read back rather than assumed: callers address the row by primary key, so none of them can
      // tell what type it is, and the refusal below is the only thing that looks.
      type: true,
      user: { select: { email: true, username: true } },
    },
  });

  // 🔴 TRPCErrors, not bare `Error`s, and that is the difference between a moderator reading the
  // reason and reading nothing. Both ruling surfaces post through `/api/mod/restriction/resolve`,
  // whose `defineModeratorEndpoint` wrapper hands a thrown value to `handleEndpointError`. A
  // non-TRPCError falls to its catch-all branch and reaches the wire as **500 "An unexpected error
  // occurred"** — the retool panel then renders "Restriction ruling: An unexpected error occurred."
  // and the whole point of the refusal is destroyed. A TRPCError keeps its status AND its message.
  //
  // All three are 4xx: each is a fact about the request, none is a server fault.
  if (!restriction) throw throwNotFoundError('Restriction record not found');
  // Checked BEFORE the already-resolved test and before any write: a row this path cannot rule on is
  // not a row whose status is worth arguing about.
  const unwired = unwiredRulingReason(restriction.type);
  if (unwired) throw throwBadRequestError(unwired);
  const effects = RULING_EFFECTS[restriction.type as UserRestrictionType];
  if (!effects)
    throw throwBadRequestError(`No verdict effects are defined for "${restriction.type}".`);
  if (restriction.status !== UserRestrictionStatus.Pending)
    throw throwBadRequestError('Restriction has already been resolved');

  // Pending in the WHERE, not just the read above: two rulings racing on one case would otherwise
  // both land, and an uphold overwriting an overturn re-mutes an account whose content was restored.
  const ruled = await dbWrite.userRestriction.updateMany({
    where: { id: userRestrictionId, status: UserRestrictionStatus.Pending },
    data: {
      status,
      resolvedAt: new Date(),
      resolvedBy: moderatorId,
      resolvedMessage,
      resolvedReason,
      internalNotes,
    },
  });
  if (!ruled.count) throw throwBadRequestError('Restriction has already been resolved');

  let stillHeld = false;
  if (status === UserRestrictionStatus.Upheld) {
    // An upheld mute is on and indefinite: the mute may have been lifted while the case was Pending
    // (ToS acceptance, decay, an expiry), and a leftover expiry would let the timed-unmute job lift it.
    await updateUserById({
      id: restriction.userId,
      data: { muted: true, mutedAt: new Date(), muteExpiresAt: null },
      updateSource: effects.upheldSource,
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
    // Under the account row lock a scam verdict also takes, so a case filed concurrently is either
    // seen here or files after the unmute and mutes again on its own.
    stillHeld = await dbWrite.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${restriction.userId} FOR UPDATE`;
      await effects.overturnInTransaction?.(tx, restriction, moderatorId);
      if (await hasOtherPendingRestriction(tx, restriction.userId, restriction.id)) return true;
      // Overturning clears the whole mute, not just the flag: an uphold sets `mutedAt`, and leaving
      // it behind on an overturn keeps the account off every leaderboard and makes the next
      // automatic mute read as a moderator's.
      const current = await tx.user.findUnique({
        where: { id: restriction.userId },
        select: { meta: true },
      });
      await tx.user.update({
        where: { id: restriction.userId },
        data: clearedMuteFields(current?.meta as UserMeta | null),
      });
      return false;
    });
    if (!stillHeld) {
      userUpdateCounter?.inc({
        location: `user.service:updateUserById:${effects.overturnedSource}`,
      });
      await reinstateSubscription({ userId: restriction.userId }).catch((error) =>
        logToAxiom({
          name: 'reinstate-stripe-subscription-restriction-overturned',
          type: 'error',
          message: (error as Error).message,
        })
      );
    }
    await effects.afterOverturn?.(restriction);
    await refreshSession(restriction.userId, { caller: 'moderation' });
  }

  // The account is still muted by another open case, so telling the user it was lifted would be false.
  if (stillHeld) {
    logToAxiom({
      name: 'user-restriction-resolved',
      type: 'info',
      details: { userRestrictionId, status, moderatorId, userId: restriction.userId, stillHeld },
    });
    return { userId: restriction.userId };
  }

  const notifType =
    status === UserRestrictionStatus.Upheld
      ? effects.upheldNotification
      : effects.overturnedNotification;

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
    details: { userRestrictionId, status, resolvedReason, moderatorId, userId: restriction.userId },
  });

  return { userId: restriction.userId };
}

export type OverturnPendingReviewMuteResult =
  | { unmuted: true; userRestrictionId: number }
  | {
      unmuted: false;
      skipped:
        | 'protected'
        | 'moderator'
        | 'manually-muted'
        | 'no-pending-restriction'
        | 'other-pending-restriction';
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

  // Overturning this one would leave the account muted by the other case, which is not "unmuted".
  if (await hasOtherPendingRestriction(dbWrite, userId, restriction.id))
    return { unmuted: false, skipped: 'other-pending-restriction' };

  await resolveUserRestriction({
    userRestrictionId: restriction.id,
    status: UserRestrictionStatus.Overturned,
    resolvedMessage,
    moderatorId,
  });

  return { unmuted: true, userRestrictionId: restriction.id };
}
