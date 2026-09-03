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

export const PROTECTED_USER_IDS = new Set<number>([
  constants.system.user.id,
  constants.system.officialUserId,
]);

/**
 * The kinds of review that file into the moderator mute queue.
 *
 * `UserRestriction.type` is a free-text column carrying a `[type, status]` index, so a new kind costs
 * no migration — but it does need a queue view that shows it, which is why this is an enumerated union
 * rather than a bare `string`. A typo would otherwise file a row into a type nothing lists.
 *
 * Mirrored for the moderator app in `apps/moderator/src/lib/server/user-restriction.service.ts`; the
 * two lists are pinned to each other by `src/server/services/__tests__/restriction-type-seam.test.ts`.
 */
export const USER_RESTRICTION_TYPES = ['generation', 'bot-account'] as const;
export type UserRestrictionType = (typeof USER_RESTRICTION_TYPES)[number];

export const DEFAULT_USER_RESTRICTION_TYPE: UserRestrictionType = 'generation';

/**
 * The notification a pending-review mute sends, per restriction type — `null` meaning "say nothing".
 *
 * 🔴 An OPT-IN map, and the `null` is the safe half rather than a gap. Two things make it the right
 * shape:
 *
 * 1. `createNotification` does not validate `type` against anything. It is `z.string()` at the schema,
 *    `text` at both tables, and the fan-out worker inserts it verbatim — so an unregistered type is
 *    persisted and *increments the user's unread badge*, while the bell dropdown drops it at render
 *    (`getNotificationMessage` returns null for an unknown type and the list `.filter(isDefined)`s it
 *    away). The result is a phantom unread count with no click target, clearable only by "mark all
 *    read". Sending an unregistered type is therefore worse than sending none.
 * 2. Reusing `generation-muted` for a non-generation mute would tell a user their *generation access*
 *    was restricted for something that has nothing to do with generation.
 *
 * So a new type stays silent until someone deliberately (a) adds a processor for it under
 * `src/server/notifications/` and reaches it from `notificationProcessors`, and (b) names it here. The
 * seam test asserts every value in this map is a registered processor key, so a mapping added without
 * the processor fails rather than ships a ghost notification.
 */
export const PENDING_REVIEW_MUTE_NOTIFICATION: Record<UserRestrictionType, string | null> = {
  generation: 'generation-muted',
  'bot-account': null,
};

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
 * `type` selects which review queue the case is filed into, and defaults to the only one that existed
 * before it was a parameter. Dedupe is scoped to it: a user already holding an open case of one type
 * can still be muted under another, because otherwise the first open case would swallow every later
 * finding of a different kind and the second queue would simply never fill.
 */
export async function applyPendingReviewMute({
  userId,
  triggers,
  updateSource,
  type = DEFAULT_USER_RESTRICTION_TYPE,
}: {
  userId: number;
  triggers: unknown[];
  updateSource: string;
  type?: UserRestrictionType;
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
    where: { userId, type, status: UserRestrictionStatus.Pending },
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
          type,
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
  const notificationType = PENDING_REVIEW_MUTE_NOTIFICATION[type];
  if (notificationType) {
    await bestEffort('pending-review-mute-notify-failed', userId, () =>
      createNotification({
        type: notificationType,
        key: `${notificationType}:${userId}:${userRestrictionId}`,
        category: NotificationCategory.System,
        userId,
        details: {},
      })
    );
  }

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
