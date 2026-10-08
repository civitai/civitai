// Keep this module's import graph light. `promptAuditing` imports it on the
// generation hot path, and pulling stripe/email in here made three of its
// suites fail to collect. Verdict handling lives in
// `user-restriction-resolve.service.ts` for that reason.
import { refreshSession } from '~/server/auth/session-invalidation';
import { PROTECTED_USER_IDS } from '~/server/utils/protected-user-ids';
import { constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { userUpdateCounter } from '~/server/prom/client';
import { createNotification } from '~/server/services/notification.service';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';
import type { Prisma } from '@prisma/client';

export { PROTECTED_USER_IDS };

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
export const USER_RESTRICTION_TYPES = ['generation', 'bot-account', 'scam'] as const;
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
  scam: 'review-muted',
};

/**
 * The restriction types a moderator's verdict can actually be applied to.
 *
 * 🔴 Deliberately NARROWER than `USER_RESTRICTION_TYPES`: a type can be filed and reviewed long before
 * anyone builds a verdict path for it. A type belongs here only once `RULING_EFFECTS` in
 * `user-restriction-resolve.service.ts` defines its notices, update sources and overturn effect.
 */
export const RULINGS_WIRED_FOR: readonly UserRestrictionType[] = ['generation', 'scam'];

/**
 * Why a verdict may not be handed to a row of this type, or `null` when it may.
 *
 * 🔴 Lives HERE, one level below every ruling surface, on purpose. There are five entry points into
 * `resolveUserRestriction` — the tRPC router, `/api/mod/restriction/resolve` (which is what BOTH
 * moderator-app ruling surfaces post through: the audit queue and the retool User Lookup panel), and
 * `overturnPendingReviewMute` — and a guard replicated per route is a predicate open-coded at N sites,
 * wrong at N−1 of them. The moderator app cannot import this module (separate build, separate
 * project), so its copy of the list is pinned to this one by
 * `src/server/services/__tests__/restriction-type-seam.test.ts` rather than left to drift.
 */
export function unwiredRulingReason(type: string): string | null {
  return (RULINGS_WIRED_FOR as readonly string[]).includes(type)
    ? null
    : `Rulings are not yet available for "${type}" restrictions — no verdict effects are defined for this type. This restriction was NOT resolved.`;
}

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
  // 🔴 Runtime, not just TypeScript — and it is worth being exact about why, because the obvious
  // justification is not true here. NOTHING crosses an HTTP boundary into this parameter today:
  // neither production caller passes a `type` at all, and the one HTTP route that reaches this
  // function (`src/pages/api/mod/mute-user-pending-review.ts`) has no `type` key in its zod schema,
  // so no request body can supply one. Every value arriving here is written by an in-process caller
  // the compiler can see.
  //
  // What the guard is for is the SHAPE OF THE NEXT CALLER. This is the one seam whose entire purpose
  // is accepting a caller-supplied type, it exists so a detector can file into this queue, and the
  // obvious way to wire one up is a route that forwards a field off a JSON body — at which point the
  // compiler's word is worth nothing and the guard is the only thing standing there. It also covers
  // the callers TypeScript cannot vouch for today: an `as` cast, a value read back from the
  // free-text `UserRestriction.type` column, or a JS caller.
  //
  // The harm it prevents is not a harmless typo: an out-of-vocabulary value MUTES the account, files
  // a row the queue's `z.enum(RESTRICTION_TYPES).catch(...)` can never select, and — via
  // `PENDING_REVIEW_MUTE_NOTIFICATION[type]` coming back `undefined` — tells the user nothing. The
  // result is a silently muted account with no reviewable case anywhere.
  //
  // A throw rather than a `skipped` result: the `skipped` union describes facts about the USER that a
  // caller is expected to handle, and this is a defect in the CALLER. Thrown before any write, so a
  // rejected call mutes nobody.
  if (!(USER_RESTRICTION_TYPES as readonly string[]).includes(type))
    throw new Error(
      `Unknown user restriction type "${type}". Known types: ${USER_RESTRICTION_TYPES.join(', ')}.`
    );

  const claim = await dbWrite.$transaction((tx) =>
    claimPendingReviewMute(tx, { userId, triggers, type })
  );
  if (claim.muted) await announcePendingReviewMute({ userId, type, updateSource, claim });
  return claim.muted
    ? { muted: true, userRestrictionId: claim.userRestrictionId, deduped: claim.deduped }
    : claim;
}

type RestrictionClient = Pick<Prisma.TransactionClient, 'user' | 'userRestriction'>;

export type PendingReviewMuteClaim =
  | { muted: true; userRestrictionId: number; deduped: boolean; wasMuted: boolean }
  | Extract<PendingReviewMuteResult, { muted: false }>;

/**
 * The database half of `applyPendingReviewMute`, for a caller that must file the case inside its own
 * transaction. Pair it with `announcePendingReviewMute` after that transaction commits.
 */
export async function claimPendingReviewMute(
  client: RestrictionClient,
  { userId, triggers, type }: { userId: number; triggers: unknown[]; type: UserRestrictionType }
): Promise<PendingReviewMuteClaim> {
  if (PROTECTED_USER_IDS.has(userId)) return { muted: false, skipped: 'protected' };

  // Primary, not the replica: this is a security gate, and replica lag would let
  // a just-promoted moderator or a just-banned account through the wrong branch.
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { isModerator: true, muted: true, bannedAt: true, deletedAt: true },
  });
  if (!user) throw new Error(`No user with id ${userId}`);
  if (user.isModerator) return { muted: false, skipped: 'moderator' };
  if (user.deletedAt) return { muted: false, skipped: 'deleted' };
  if (user.bannedAt) return { muted: false, skipped: 'banned' };

  const existing = await client.userRestriction.findFirst({
    where: { userId, type, status: UserRestrictionStatus.Pending },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  // Repairs the one state a Pending row must never be left in: queued against
  // an unmuted account, where an uphold sets `mutedAt` without `muted` and the
  // user keeps generating while confirm-mutes acts on them.
  if (!user.muted) await client.user.update({ where: { id: userId }, data: { muted: true } });
  if (existing)
    return { muted: true, userRestrictionId: existing.id, deduped: true, wasMuted: user.muted };

  const restriction = await client.userRestriction.create({
    data: {
      userId,
      type,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      triggers: triggers as any,
    },
    select: { id: true },
  });
  return { muted: true, userRestrictionId: restriction.id, deduped: false, wasMuted: user.muted };
}

export async function announcePendingReviewMute({
  userId,
  type,
  updateSource,
  claim,
}: {
  userId: number;
  type: UserRestrictionType;
  updateSource: string;
  claim: Extract<PendingReviewMuteClaim, { muted: true }>;
}) {
  userUpdateCounter?.inc({ location: `user-restriction.service:${updateSource}` });

  // Another finding against an open case on a muted account changes nothing the session or the user
  // needs to hear about; the case's notice already went out when it was filed.
  if (claim.deduped && claim.wasMuted) return;

  await bestEffort('pending-review-mute-refresh-session-failed', userId, () =>
    refreshSession(userId, { caller: 'moderation' })
  );
  const notificationType = PENDING_REVIEW_MUTE_NOTIFICATION[type];
  if (notificationType) {
    await bestEffort('pending-review-mute-notify-failed', userId, () =>
      createNotification({
        type: notificationType,
        key: `${notificationType}:${userId}:${claim.userRestrictionId}`,
        category: NotificationCategory.System,
        userId,
        details: {},
      })
    );
  }
}

/**
 * Whether the account has an open case (of `type`, when given) other than `exceptId`. A ruling asks
 * this before lifting the mute, so overturning one case does not release an account another case
 * still holds; a system release asks it for scam cases, whose mute only a ruling ends.
 */
export async function hasOtherPendingRestriction(
  client: Pick<Prisma.TransactionClient, 'userRestriction'>,
  userId: number,
  exceptId?: number,
  type?: UserRestrictionType
) {
  const other = await client.userRestriction.findFirst({
    where: {
      userId,
      status: UserRestrictionStatus.Pending,
      ...(type ? { type } : {}),
      ...(exceptId !== undefined ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  return !!other;
}

/**
 * Not a ruling, so no notice and no change to the mute: the review queue hides deleted accounts,
 * and a case left Pending there would never be ruled on.
 *
 * Generation only. A Pending scam case is part of the mute ledger: it blocks system releases and a
 * moderator unmute closes it, restoring content and voiding strikes (`mute-release.service.ts`,
 * `scam-case-ledger.ts`). Both select `Pending`, so closing it here would disarm both.
 */
export async function closeGenerationRestrictionsOfDeletedAccount(userId: number) {
  return dbWrite.$executeRaw`
    UPDATE "UserRestriction"
    SET status = 'AccountDeleted', "resolvedAt" = now(), "resolvedBy" = ${constants.system.user.id},
        "resolvedMessage" = 'Closed automatically: the account was deleted.', "updatedAt" = now()
    WHERE "userId" = ${userId} AND type = 'generation' AND status = 'Pending'
  `;
}

/**
 * Puts a restored account's closed cases back in the queue, but only while the account is still
 * muted: a Pending case must never sit on an unmuted account, and if the mute was lifted while the
 * account was deleted (an overturn of another case no longer sees this one), restoring the account
 * must not silently re-mute it.
 */
export async function reopenGenerationRestrictionsOfRestoredAccount(userId: number) {
  return dbWrite.$executeRaw`
    UPDATE "UserRestriction"
    SET status = 'Pending', "resolvedAt" = NULL, "resolvedBy" = NULL, "resolvedMessage" = NULL,
        "updatedAt" = now()
    WHERE "userId" = ${userId} AND type = 'generation' AND status = 'AccountDeleted'
      AND EXISTS (SELECT 1 FROM "User" WHERE id = ${userId} AND muted)
  `;
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
