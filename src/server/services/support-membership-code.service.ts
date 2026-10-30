import dayjs from '~/shared/utils/dayjs';
import { dbWrite } from '~/server/db/client';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { trackModActivity } from '~/server/services/moderator.service';
import { generateRedeemCode } from '~/server/utils/redeem-code';
import { Prisma } from '@prisma/client';
import {
  SUPPORT_MEMBERSHIP_CODE_LIMITS,
  SUPPORT_MEMBERSHIP_CODE_SOURCE,
  SUPPORT_MEMBERSHIP_CODE_TIERS,
  type SupportMembershipCodeTier,
} from '~/server/services/support-membership-code.constants';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import { PaymentProvider, RedeemableCodeType } from '~/shared/utils/prisma/enums';

export {
  SUPPORT_MEMBERSHIP_CODE_LIMITS,
  SUPPORT_MEMBERSHIP_CODE_TIERS,
} from '~/server/services/support-membership-code.constants';

/** ModActivity prefix. The daily cap counts it, so renaming it resets every moderator's count. */
const ACTIVITY_PREFIX = 'mintMembershipCode:';
const REVOKED_EXPIRY = new Date(0);
/** Advisory-lock class ('MC'), registered in free-placement.service.test.ts's lock ledger. */
const MINT_LOCK_CLASS = 0x4d430001;

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
  // The code is bound to `forUserId` at redemption, so a self-mint would be a moderator paying
  // themselves.
  if (forUserId === moderatorId)
    throw throwBadRequestError('You cannot mint a membership code for your own account.');

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
    // Both arguments int4: Prisma binds a JS number as int8, and there is no (int4, int8) overload.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MINT_LOCK_CLASS}::int, ${moderatorId}::int)`;

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

    const code = generateRedeemCode('MB');
    // UTC: a local-time day add drifts by an hour across a DST change.
    const expiresAt = dayjs.utc().add(limits.expiryDays, 'day').toDate();
    await tx.redeemableCode
      .create({
        data: {
          code,
          type: RedeemableCodeType.Membership,
          unitValue: months,
          priceId: price.id,
          // Pre-set to the customer: support lists an account's codes by the indexed
          // (userId, createdAt), and the customer sees the code among their own.
          userId: forUserId,
          expiresAt,
          metadata: {
            source: SUPPORT_MEMBERSHIP_CODE_SOURCE,
            mintedBy: moderatorId,
            forUserId,
            reason: trimmedReason,
          },
        },
      })
      .catch((e: unknown) => {
        // A 4xx, not a 500: the transaction rolled back, so nothing was minted and a retry is safe.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw throwConflictError(
            'Generated a code that already exists. Nothing was minted; try again.'
          );
        throw e;
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

/**
 * Withdraw an unredeemed support code: it is expired now and stamped with who revoked it, so the
 * row keeps its audit trail. Scoped to the account it was minted for, so a code cannot be revoked
 * from another customer's page.
 */
export async function revokeSupportMembershipCode({
  code,
  forUserId,
  moderatorId,
}: {
  code: string;
  forUserId: number;
  moderatorId: number;
}) {
  return dbWrite.$transaction(async (tx) => {
    const row = await tx.redeemableCode.findFirst({
      where: { code, userId: forUserId },
      select: {
        code: true,
        unitValue: true,
        priceId: true,
        redeemedAt: true,
        expiresAt: true,
        metadata: true,
      },
    });
    const metadata = (row?.metadata ?? null) as Record<string, unknown> | null;
    if (!row || metadata?.source !== SUPPORT_MEMBERSHIP_CODE_SOURCE)
      throw throwNotFoundError('No support membership code with that code on this account.');
    if (row.redeemedAt) throw throwConflictError('That code has already been redeemed.');
    const now = new Date();
    if (metadata.revokedAt) throw throwConflictError('That code has already been revoked.');
    if (row.expiresAt && row.expiresAt <= now)
      throw throwConflictError('That code has already expired.');

    // Guarded on still being unredeemed: a redemption that landed after the read wins, and nothing
    // is recorded as revoked.
    const { count } = await tx.redeemableCode.updateMany({
      where: { code, userId: forUserId, redeemedAt: null },
      data: {
        // The epoch, not `now`: a redeem already in flight compares expiresAt against its own
        // earlier clock reading, and would still beat a "now" written by this revoke. The revoke
        // time is kept in metadata.
        expiresAt: REVOKED_EXPIRY,
        metadata: { ...metadata, revokedBy: moderatorId, revokedAt: now.toISOString() },
      },
    });
    if (count !== 1) throw throwConflictError('That code was redeemed while being revoked.');

    const tier = row.priceId?.replace(/-monthly$/, '') ?? 'unknown';
    await trackModActivity(
      moderatorId,
      {
        entityType: 'user',
        entityId: forUserId,
        activity: `revokeMembershipCode:${tier}:${row.unitValue}`,
      },
      tx
    );

    return { code, revokedAt: now };
  });
}
