// Keep this module's import graph light. `promptAuditing` imports it on the
// generation hot path, and pulling stripe/email in here made three of its
// suites fail to collect. Verdict handling lives in
// `user-restriction-resolve.service.ts` for that reason.
import { refreshSession } from '~/server/auth/session-invalidation';
import { constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { userUpdateCounter } from '~/server/prom/client';
import { createNotification } from '~/server/services/notification.service';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';

const PROTECTED_USER_IDS = new Set<number>([
  constants.system.user.id,
  constants.system.officialUserId,
]);

export type PendingReviewMuteResult =
  | { muted: true; userRestrictionId: number; deduped: boolean }
  | { muted: false; skipped: 'protected' | 'moderator' | 'banned' | 'deleted' };

async function bestEffort(name: string, userId: number, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    logToAxiom({ type: 'error', name, message: (e as Error).message, details: { userId } });
  }
}

/**
 * Mute a user *pending moderator review*: the account is paused and the case is
 * queued, but no verdict has been reached.
 *
 * `mutedAt` is deliberately not written. It marks a moderator's uphold, and
 * `confirm-mutes` cancels the user's memberships off a recent non-null value —
 * so setting it here would bill-punish an unreviewed account.
 *
 * Resolving means the mute landed; the session refresh and notification after it
 * are best-effort, so a caller that gets a result can always trust it and audit it.
 */
export async function applyPendingReviewMute({
  userId,
  triggers,
  updateSource,
}: {
  userId: number;
  triggers: unknown[];
  updateSource: string;
}): Promise<PendingReviewMuteResult> {
  if (PROTECTED_USER_IDS.has(userId)) return { muted: false, skipped: 'protected' };

  // Primary, not the replica: this is a security gate, and replica lag would let
  // a just-promoted moderator or a just-banned account through the wrong branch.
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { isModerator: true, muted: true, bannedAt: true, deletedAt: true },
  });
  if (!user) throw new Error(`No user with id ${userId}`);
  if (user.isModerator) return { muted: false, skipped: 'moderator' };
  if (user.deletedAt) return { muted: false, skipped: 'deleted' };
  if (user.bannedAt) return { muted: false, skipped: 'banned' };

  const existing = await dbWrite.userRestriction.findFirst({
    where: { userId, type: 'generation', status: UserRestrictionStatus.Pending },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  let userRestrictionId: number;
  const deduped = !!existing;

  if (existing) {
    userRestrictionId = existing.id;
    // Repairs the one state a Pending row must never be left in: queued against
    // an unmuted account, where an uphold sets `mutedAt` without `muted` and the
    // user keeps generating while confirm-mutes acts on them.
    if (!user.muted) await dbWrite.user.update({ where: { id: userId }, data: { muted: true } });
  } else {
    const [, restriction] = await dbWrite.$transaction([
      dbWrite.user.update({ where: { id: userId }, data: { muted: true } }),
      dbWrite.userRestriction.create({
        data: {
          userId,
          type: 'generation',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          triggers: triggers as any,
        },
        select: { id: true },
      }),
    ]);
    userRestrictionId = restriction.id;
  }

  userUpdateCounter?.inc({ location: `user-restriction.service:${updateSource}` });

  await bestEffort('pending-review-mute-refresh-session-failed', userId, () =>
    refreshSession(userId, { caller: 'moderation' })
  );
  await bestEffort('pending-review-mute-notify-failed', userId, () =>
    createNotification({
      type: 'generation-muted',
      key: `generation-muted:${userId}:${userRestrictionId}`,
      category: NotificationCategory.System,
      userId,
      details: {},
    })
  );

  return { muted: true, userRestrictionId, deduped };
}

/**
 * Shapes a free-text reason into the trigger entries the moderator review UI
 * renders, so a mute raised by a service or by hand isn't reviewed blind.
 */
export function buildManualMuteTriggers({
  reason,
  source,
  prompts,
}: {
  reason: string;
  source: string;
  prompts?: string[];
}) {
  const time = new Date().toISOString();
  return (prompts?.length ? prompts : [reason]).map((prompt) => ({
    prompt,
    negativePrompt: '',
    source,
    matchedWord: reason,
    imageId: null,
    remixOfId: null,
    time,
  }));
}
