import dayjs from '~/shared/utils/dayjs';
import { dbWrite } from '~/server/db/client';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  throwBadRequestError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import { PaymentProvider, RedeemableCodeType } from '~/shared/utils/prisma/enums';
import { generateToken } from '~/utils/string-helpers';

export const SUPPORT_MEMBERSHIP_CODE_TIERS = ['bronze', 'silver', 'gold'] as const;
export type SupportMembershipCodeTier = (typeof SUPPORT_MEMBERSHIP_CODE_TIERS)[number];

export const SUPPORT_MEMBERSHIP_CODE_LIMITS = {
  maxMonths: 6,
  dailyPerModerator: 10,
  expiryDays: 30,
} as const;

/** ModActivity prefix. The daily cap counts it, so renaming it resets every moderator's count. */
const ACTIVITY_PREFIX = 'mintMembershipCode:';

/** Same shape `createRedeemableCodes` mints, so support codes are indistinguishable at redemption. */
export function generateMembershipCode() {
  return `MB-${generateToken(4)}-${generateToken(4)}`.toUpperCase();
}

/**
 * One Membership redeem code for a customer, minted by a moderator. The customer redeems it at
 * /redeem-code, so the membership itself is built by `consumeRedeemableCode` exactly as for any code.
 *
 * Who minted it, for whom and why is written into the code row, and the ModActivity row goes through
 * the same transaction: the daily cap counts ModActivity, so the two cannot disagree.
 */
export async function mintSupportMembershipCode({
  forUserId,
  tier,
  months,
  reason,
  moderatorId,
}: {
  forUserId: number;
  tier: SupportMembershipCodeTier;
  months: number;
  reason: string;
  moderatorId: number;
}) {
  const limits = SUPPORT_MEMBERSHIP_CODE_LIMITS;
  if (!Number.isInteger(months) || months < 1 || months > limits.maxMonths)
    throw throwBadRequestError(`Months must be a whole number from 1 to ${limits.maxMonths}.`);
  if (!SUPPORT_MEMBERSHIP_CODE_TIERS.includes(tier))
    throw throwBadRequestError(`Unknown tier "${tier}".`);
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw throwBadRequestError('A reason is required.');

  // Civitai-provider prices only: a code for any other provider is refused at redemption.
  const priceId = `${tier}-monthly`;
  const price = await dbWrite.price.findFirst({
    where: { id: priceId, active: true, product: { provider: PaymentProvider.Civitai } },
    select: { id: true, product: { select: { metadata: true } } },
  });
  if (!price) throw throwBadRequestError(`No active Civitai price ${priceId}.`);
  if ((price.product.metadata as SubscriptionProductMetadata | null)?.tier !== tier)
    throw throwBadRequestError(`Price ${priceId} is not a ${tier} tier product.`);

  const target = await dbWrite.user.findFirst({
    where: { id: forUserId },
    select: { id: true, deletedAt: true },
  });
  if (!target || target.deletedAt) throw throwNotFoundError(`No live user with id ${forUserId}.`);

  return dbWrite.$transaction(async (tx) => {
    // Serialises one moderator's mints so two concurrent requests cannot both pass the cap.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('support-membership-code'), ${moderatorId})`;

    const minted = await tx.modActivity.count({
      where: {
        userId: moderatorId,
        activity: { startsWith: ACTIVITY_PREFIX },
        createdAt: { gt: dayjs().subtract(24, 'hour').toDate() },
      },
    });
    if (minted >= limits.dailyPerModerator)
      throw throwRateLimitError(
        `Daily limit of ${limits.dailyPerModerator} membership codes per moderator reached.`
      );

    const code = generateMembershipCode();
    // UTC: a local-time day add drifts by an hour across a DST change.
    const expiresAt = dayjs.utc().add(limits.expiryDays, 'day').toDate();
    await tx.redeemableCode.create({
      data: {
        code,
        type: RedeemableCodeType.Membership,
        unitValue: months,
        priceId: price.id,
        expiresAt,
        metadata: {
          source: 'moderator-membership-code',
          mintedBy: moderatorId,
          forUserId,
          reason: trimmedReason,
        },
      },
    });
    // No code in the activity text: account history is visible to moderators who cannot mint, and
    // an unredeemed code is a bearer credential.
    await trackModActivity(
      moderatorId,
      { entityType: 'user', entityId: forUserId, activity: `${ACTIVITY_PREFIX}${tier}:${months}` },
      tx
    );

    return { code, expiresAt, tier, months };
  });
}
