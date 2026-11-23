import { TRPCError } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { giftableTierSchema, type GiftableTier } from '~/server/schema/membership-gift.schema';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import {
  fulfillMembershipGift,
  getRecipientGiftability,
  type RecipientGiftability,
} from '~/server/services/membership-gift.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import { MembershipGiftStatus } from '~/shared/utils/prisma/enums';

export const COMP_GIFT_LIMITS = { maxMonths: 12, dailyPerModerator: 10 } as const;

/** ModActivity prefix. The daily cap counts it, so renaming it resets every moderator's count. */
const COMP_ACTIVITY_PREFIX = 'compMembershipGift:';
const REVOKE_ACTIVITY_PREFIX = 'revokeCompMembershipGift:';
/** Advisory-lock class ('MG'), registered in free-placement.service.test.ts's lock ledger. */
const COMP_LOCK_CLASS = 0x4d470001;

const log = (data: MixedObject) => logToAxiom({ name: 'membership-gift', ...data }, 'webhooks');

/** Collaborators, injectable so tests need not mock this repo's own modules. */
export const compGiftDeps = {
  trackModActivity,
  fulfillMembershipGift,
  getRecipientGiftability,
  throwOnBlockedUserContent,
};
type CompGiftDeps = typeof compGiftDeps;

type Actor = { id: number; roles?: string[] };

async function assertCompGrant(actor: Actor) {
  if (!(await hasModeratorGrant(actor, 'user.membership.gift.comp')))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'Comping a membership gift needs the "user.membership.gift.comp" moderator permission.',
    });
}

/** A comp is the only gift with no Stripe payment behind it. */
export const isCompGift = (gift: {
  amountCents: number;
  stripePaymentIntentId: string | null;
  stripeCheckoutSessionId: string | null;
}) => gift.amountCents === 0 && !gift.stripePaymentIntentId && !gift.stripeCheckoutSessionId;

export type CompGiftResult =
  | {
      outcome: 'would-comp';
      recipient: { id: number; username: string | null };
      tier: GiftableTier;
      months: number;
      giftability: RecipientGiftability;
      compsInLast24h: number;
    }
  | {
      outcome: 'comped';
      giftId: string;
      recipient: { id: number; username: string | null };
      tier: GiftableTier;
      months: number;
      /** False when the gift row exists but fulfilment failed: re-running fulfilment is safe. */
      fulfilled: boolean;
    };

/**
 * A membership gift from a moderator that nobody pays for. The row goes through the same
 * fulfilment as a paid gift, so the recipient is notified and accepts it as usual.
 *
 * The gift row and its ModActivity row share one transaction: the daily cap counts ModActivity,
 * so the two cannot disagree.
 */
export async function compMembershipGift({
  recipientId,
  tier,
  months,
  reason,
  message,
  anonymous = false,
  execute = false,
  actor,
  deps = compGiftDeps,
}: {
  recipientId: number;
  tier: GiftableTier;
  months: number;
  reason: string;
  message?: string;
  anonymous?: boolean;
  execute?: boolean;
  actor: Actor;
  deps?: CompGiftDeps;
}): Promise<CompGiftResult> {
  await assertCompGrant(actor);
  const moderatorId = actor.id;
  if (!Number.isInteger(months) || months < 1 || months > COMP_GIFT_LIMITS.maxMonths)
    throw throwBadRequestError(
      `Months must be a whole number from 1 to ${COMP_GIFT_LIMITS.maxMonths}.`
    );
  if (!giftableTierSchema.safeParse(tier).success)
    throw throwBadRequestError(`Unknown tier "${tier}".`);
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw throwBadRequestError('A reason is required.');
  if (recipientId === moderatorId)
    throw throwBadRequestError('You cannot comp a membership gift to your own account.');

  // primary: a ban or mute applied moments ago must refuse the gift.
  const recipient = await dbWrite.user.findUnique({
    where: { id: recipientId },
    select: { id: true, username: true, deletedAt: true, bannedAt: true, muted: true },
  });
  if (!recipient || recipient.deletedAt)
    throw throwNotFoundError(`No live user with id ${recipientId}.`);
  if (recipient.bannedAt)
    throw throwBadRequestError('This user is banned and cannot receive gifts.');
  if (recipient.muted) throw throwBadRequestError('This user is muted and cannot receive gifts.');

  const giftability = await deps.getRecipientGiftability({ recipientUserId: recipientId });
  if (giftability.status === 'blocked' && giftability.reason === 'unsupported-provider')
    throw throwBadRequestError("This user's membership cannot receive gifted months.");

  const trimmedMessage = message?.trim() || undefined;
  // The message is emailed to the recipient.
  if (trimmedMessage)
    await deps.throwOnBlockedUserContent(trimmedMessage, { surface: 'membership-gift' });

  const who = { id: recipient.id, username: recipient.username };
  const since = () => dayjs().subtract(24, 'hour').toDate();

  if (!execute) {
    const compsInLast24h = await dbRead.modActivity.count({
      where: {
        userId: moderatorId,
        activity: { startsWith: COMP_ACTIVITY_PREFIX },
        createdAt: { gt: since() },
      },
    });
    return { outcome: 'would-comp', recipient: who, tier, months, giftability, compsInLast24h };
  }

  const gift = await dbWrite.$transaction(async (tx) => {
    // Serialises one moderator's comps so two concurrent requests cannot both pass the cap.
    // Both arguments int4: Prisma binds a JS number as int8, and there is no (int4, int8) overload.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMP_LOCK_CLASS}::int, ${moderatorId}::int)`;

    const comped = await tx.modActivity.count({
      where: {
        userId: moderatorId,
        activity: { startsWith: COMP_ACTIVITY_PREFIX },
        createdAt: { gt: since() },
      },
    });
    if (comped >= COMP_GIFT_LIMITS.dailyPerModerator)
      throw throwRateLimitError(
        `Daily limit of ${COMP_GIFT_LIMITS.dailyPerModerator} comped gifts per moderator reached.`
      );

    const created = await tx.membershipGift.create({
      data: {
        gifterId: moderatorId,
        recipientId,
        holderId: recipientId,
        tier,
        months,
        amountCents: 0,
        message: trimmedMessage,
        anonymous,
      },
      select: { id: true },
    });
    await deps.trackModActivity(
      moderatorId,
      {
        entityType: 'user',
        entityId: recipientId,
        activity: `${COMP_ACTIVITY_PREFIX}${tier}:${months}`,
      },
      tx
    );
    return created;
  });

  await log({
    type: 'info',
    stage: 'comp',
    giftId: gift.id,
    moderatorId,
    recipientId,
    tier,
    months,
    reason: trimmedReason,
  });

  // Outside the transaction: fulfilment notifies and emails. A failure here leaves a Pending row
  // that fulfilment can finish later, so it is reported rather than thrown into a retry that
  // would comp a second gift.
  const fulfilled = await deps.fulfillMembershipGift({ giftId: gift.id }).then(
    () => true,
    async (error: unknown) => {
      await log({ type: 'error', stage: 'comp-fulfil', giftId: gift.id, message: String(error) });
      return false;
    }
  );

  return { outcome: 'comped', giftId: gift.id, recipient: who, tier, months, fulfilled };
}

export type CompGiftRevocation =
  | {
      outcome: 'would-revoke' | 'revoked';
      giftId: string;
      status: MembershipGiftStatus;
      monthsRemaining: number;
    }
  | { outcome: 'already-revoked'; status: MembershipGiftStatus };

const REVOKED_STATUSES: MembershipGiftStatus[] = [
  MembershipGiftStatus.Refunded,
  MembershipGiftStatus.Revoked,
  MembershipGiftStatus.Failed,
];

/**
 * Take back a comped gift that has not been accepted, for a comp made by mistake. Acceptance can move
 * the holder up a tier, and removing the gift afterwards would leave them paying for that tier, so an
 * accepted comp is left to an engineer.
 */
export async function revokeCompMembershipGift({
  giftId,
  execute = false,
  actor,
  deps = compGiftDeps,
}: {
  giftId: string;
  execute?: boolean;
  actor: Actor;
  deps?: CompGiftDeps;
}): Promise<CompGiftRevocation> {
  await assertCompGrant(actor);
  const moderatorId = actor.id;
  // primary: guards the revoke that follows.
  const gift = await dbWrite.membershipGift.findUnique({
    where: { id: giftId },
    select: {
      id: true,
      status: true,
      holderId: true,
      monthsRemaining: true,
      acceptedAt: true,
      amountCents: true,
      stripePaymentIntentId: true,
      stripeCheckoutSessionId: true,
    },
  });
  if (!gift) throw throwNotFoundError(`No membership gift ${giftId}.`);
  if (!isCompGift(gift))
    throw throwBadRequestError(
      'This gift was paid for. Use revoke-unpaid or refund-unfulfilled instead.'
    );
  if (REVOKED_STATUSES.includes(gift.status))
    return { outcome: 'already-revoked', status: gift.status };
  const unaccepted =
    !gift.acceptedAt &&
    (gift.status === MembershipGiftStatus.Pending ||
      gift.status === MembershipGiftStatus.Fulfilled);
  if (!unaccepted)
    throw throwConflictError(
      'This comp has been accepted. Taking it back can change what the holder pays, so it needs an engineer; nothing was changed.'
    );

  const summary = { giftId: gift.id, status: gift.status, monthsRemaining: gift.monthsRemaining };
  if (!execute) return { outcome: 'would-revoke', ...summary };

  // The unaccepted state is part of the write, so an accept that claims the gift first wins
  // (see acceptMembershipGift). An unaccepted gift has nothing in Stripe to undo.
  const { count } = await dbWrite.membershipGift.updateMany({
    where: {
      id: gift.id,
      acceptedAt: null,
      status: { in: [MembershipGiftStatus.Pending, MembershipGiftStatus.Fulfilled] },
    },
    data: { status: MembershipGiftStatus.Revoked, monthsRemaining: 0 },
  });
  if (count === 0)
    throw throwConflictError('This comp was accepted or changed just now; nothing was revoked.');

  await deps.trackModActivity(moderatorId, {
    entityType: 'user',
    entityId: gift.holderId,
    activity: `${REVOKE_ACTIVITY_PREFIX}${gift.id}`,
  });
  await log({ type: 'warning', stage: 'comp-revoke', giftId: gift.id, moderatorId });

  return { outcome: 'revoked', ...summary };
}
