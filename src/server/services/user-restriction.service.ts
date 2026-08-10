import { refreshSession } from '~/server/auth/session-invalidation';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { createNotification } from '~/server/services/notification.service';
import { updateUserById } from '~/server/services/user.service';

export type PendingReviewMuteResult =
  | { muted: true; userRestrictionId: number }
  | { muted: false; skipped: 'moderator' };

/**
 * Mute a user *pending moderator review*: the account is paused and the case is
 * queued, but no verdict has been reached.
 *
 * `mutedAt` is deliberately not written. It marks a moderator's uphold, and
 * `confirm-mutes` cancels the user's memberships off a recent non-null value —
 * so setting it here would bill-punish an unreviewed account.
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
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: { isModerator: true },
  });
  if (!user) throw new Error(`No user with id ${userId}`);
  if (user.isModerator) return { muted: false, skipped: 'moderator' };

  const restriction = await dbWrite.userRestriction.create({
    data: {
      userId,
      type: 'generation',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      triggers: triggers as any,
    },
    select: { id: true },
  });

  await updateUserById({ id: userId, data: { muted: true }, updateSource });

  await refreshSession(userId, { caller: 'moderation' });

  await createNotification({
    type: 'generation-muted',
    key: `generation-muted:${userId}:${Date.now()}`,
    category: NotificationCategory.System,
    userId,
    details: {},
  }).catch();

  return { muted: true, userRestrictionId: restriction.id };
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
