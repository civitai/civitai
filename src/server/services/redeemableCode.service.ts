import dayjs from '~/shared/utils/dayjs';
import { constants, KEY_VALUE_KEYS } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type {
  ConsumeRedeemableCodeInput,
  CreateRedeemableCodeInput,
  DeleteRedeemableCodeInput,
  UpsertGiftNoticeInput,
  DeleteGiftNoticeInput,
} from '~/server/schema/redeemableCode.schema';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { throwDbCustomError, withRetries } from '~/server/utils/errorHandling';
import { refreshSession } from '~/server/auth/session-invalidation';
import { PaymentProvider, RedeemableCodeType } from '~/shared/utils/prisma/enums';
import { generateToken } from '~/utils/string-helpers';
import { deliverMonthlyCosmetics } from './subscriptions.service';
import { updateServiceTier } from '~/server/integrations/freshdesk';
import { invalidateSubscriptionCaches } from '~/server/utils/subscription.utils';
import type { GiftNotice } from '~/server/schema/redeemableCode.schema';
import { dbRead } from '~/server/db/client';

// Membership tier to Buzz conversion rates (per month)
const MEMBERSHIP_BUZZ_VALUES = {
  bronze: 10000,
  silver: 25000,
  gold: 50000,
} as const;

/**
 * Converts a redeemed code value to Buzz units for gift notice comparison
 */
function convertCodeValueToBuzz(
  type: RedeemableCodeType,
  unitValue: number,
  tierName?: string
): number {
  if (type === RedeemableCodeType.Buzz) {
    return unitValue;
  }

  if (type === RedeemableCodeType.Membership && tierName) {
    const tier = tierName.toLowerCase() as keyof typeof MEMBERSHIP_BUZZ_VALUES;
    const buzzPerMonth = MEMBERSHIP_BUZZ_VALUES[tier];

    if (!buzzPerMonth) {
      // Unknown tier, default to bronze
      return unitValue * MEMBERSHIP_BUZZ_VALUES.bronze;
    }

    return unitValue * buzzPerMonth;
  }

  // Fallback
  return unitValue;
}

/**
 * Gets gift notices that match the redeemed code value and current date
 */
async function getMatchingGiftNotices(buzzValue: number): Promise<GiftNotice[]> {
  const now = new Date();

  // Fetch notices from KeyValue table
  const noticesRecord = await dbRead.keyValue.findUnique({
    where: { key: KEY_VALUE_KEYS.REDEEM_CODE_GIFT_NOTICES },
  });

  if (!noticesRecord?.value) {
    return [];
  }

  const allNotices = noticesRecord.value as GiftNotice[];

  // Filter notices by date range and value range
  const matchingNotices = allNotices.filter((notice) => {
    const startDate = new Date(notice.startDate);
    const endDate = new Date(notice.endDate);

    // Check date range (inclusive on both ends)
    if (now < startDate || now > endDate) {
      return false;
    }

    // Check value range
    const meetsMinValue = buzzValue >= notice.minValue;
    const meetsMaxValue = notice.maxValue === null || buzzValue <= notice.maxValue;

    return meetsMinValue && meetsMaxValue;
  });

  return matchingNotices;
}

export async function createRedeemableCodes({
  unitValue,
  type,
  expiresAt,
  quantity = 1,
  priceId,
}: CreateRedeemableCodeInput) {
  if (priceId) {
    // Confirm it exists:
    const price = await dbWrite.price.findUnique({
      where: { id: priceId, active: true },
      select: {
        id: true,
        product: {
          select: { id: true, name: true, metadata: true },
        },
      },
    });

    if (!price) {
      throw new Error('Price ID does not exist');
    }
  }

  const codes = Array.from({ length: quantity }, () => {
    const code = `${type === RedeemableCodeType.Buzz ? 'CS' : 'MB'}-${generateToken(
      4
    )}-${generateToken(4)}`.toUpperCase();
    return { code, unitValue, expiresAt, type, priceId };
  });

  await dbWrite.redeemableCode.createMany({ data: codes });
  return codes.map((code) => code.code);
}

export function deleteRedeemableCode({ code }: DeleteRedeemableCodeInput) {
  return dbWrite.redeemableCode
    .delete({
      where: { code, redeemedAt: null },
    })
    .catch(throwDbCustomError('Code does not exist or has been redeemed'));
}

export async function consumeRedeemableCode({
  code,
  userId,
}: ConsumeRedeemableCodeInput & { userId: number }) {
  const codeRecord = await dbWrite.redeemableCode.findUnique({
    where: { code },
    select: {
      code: true,
      unitValue: true,
      type: true,
      userId: true,
      priceId: true,
      price: {
        select: {
          id: true,
          currency: true,
          interval: true,
          product: {
            select: { id: true, name: true, metadata: true, provider: true },
          },
        },
      },
      redeemedAt: true,
    },
  });

  if (!codeRecord) {
    throw new Error('Code does not exist or has been redeemed');
  }

  if (codeRecord.redeemedAt) {
    if (codeRecord.userId !== userId) {
      throw new Error('Code does not exist or has been redeemed');
    }
    // let's clear user session just in case.
    await refreshSession(userId);

    // Calculate Buzz value and get matching gift notices even for already-redeemed codes
    const tierName =
      codeRecord.type === RedeemableCodeType.Membership
        ? (codeRecord.price?.product?.metadata as SubscriptionProductMetadata)?.tier
        : undefined;

    const buzzValue = convertCodeValueToBuzz(codeRecord.type, codeRecord.unitValue, tierName);
    const giftNotices = await getMatchingGiftNotices(buzzValue);

    return {
      ...codeRecord,
      giftNotices,
    }; // Already redeemed by this user, return the record with gift notices.
  }

  if (codeRecord.type === RedeemableCodeType.Membership && !codeRecord.price) {
    throw new Error('Membership codes must have a price ID');
  }

  if (
    codeRecord.type === RedeemableCodeType.Membership &&
    codeRecord.price?.product?.provider !== PaymentProvider.Civitai
  ) {
    throw new Error('Cannot redeem codes for non-Civitai products');
  }

  const consumedCode = await dbWrite.$transaction(
    async (tx) => {
      const consumedCode = await tx.redeemableCode.update({
        where: {
          code,
          redeemedAt: null,
          OR: [{ expiresAt: { gt: new Date() } }, { expiresAt: null }],
        },
        data: { redeemedAt: new Date(), userId },
        select: {
          code: true,
          unitValue: true,
          redeemedAt: true,
          type: true,
          userId: true,
          priceId: true,
          price: {
            select: {
              id: true,
              currency: true,
              interval: true,
              product: {
                select: { id: true, name: true, metadata: true, provider: true },
              },
            },
          },
        },
      });

      if (consumedCode.type === RedeemableCodeType.Buzz) {
        const transactionId = `redeemable-code-${consumedCode.code}`;

        await withRetries(() =>
          createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: consumedCode.userId as number,
            amount: consumedCode.unitValue,
            description: `Redeemed code ${consumedCode.code}`,
            type: TransactionType.Redeemable,
            externalTransactionId: transactionId,
          })
        );

        await tx.redeemableCode.update({
          where: { code },
          data: { transactionId },
        });
      } else if (consumedCode.type === RedeemableCodeType.Membership && consumedCode.price) {
        // Do membership stuff:
        // First, fetch user membership and see their status:
        const userMembership = await tx.customerSubscription.findFirst({
          where: {
            userId,
            buzzType: 'yellow',
          }, // Redeemable codes only work with yellow buzz memberships
          select: {
            status: true,
            id: true,
            productId: true,
            priceId: true,
            currentPeriodEnd: true,
            metadata: true,
            product: {
              select: {
                id: true,
                name: true,
                metadata: true,
                provider: true,
              },
            },
          },
        });

        let activeUserMembership = userMembership;
        // Track whether to grant buzz immediately
        // Only grant buzz for: new users (no membership) or upgrades (higher tier)
        // Do NOT grant buzz for: same tier extensions or downgrades
        let shouldGrantBuzzImmediately = false;

        const consumedProductMetadata = consumedCode.price.product
          .metadata as SubscriptionProductMetadata;
        const consumedProductTier = consumedProductMetadata.tier ?? 'free';

        // Calculate external transaction ID for buzz delivery (to be stored in metadata)
        const date = dayjs().format('YYYY-MM');
        const externalTransactionId = `civitai-membership:${date}:${userId}:${consumedCode.price.product.id}:${consumedCode.code}`;

        if (userMembership) {
          // Check states:
          if (userMembership.status !== 'active') {
            // We can safely delete this inactive membership:
            await tx.customerSubscription.delete({
              where: { id: userMembership.id },
            });
            activeUserMembership = null;
          } else if (userMembership.currentPeriodEnd <= new Date()) {
            // Handle expired but still "active" memberships
            await tx.customerSubscription.delete({
              where: { id: userMembership.id },
            });
            activeUserMembership = null;
          }

          if (!activeUserMembership) {
            // Log:
            await logToAxiom({
              message: `Redeemed code for user ${userId} but found no active membership, deleting old membership`,
              level: 'info',
              userId,
              code: consumedCode.code,
            });
          }

          // Check provider compatibility for any remaining active membership
          if (
            activeUserMembership &&
            activeUserMembership.product.provider !== consumedCode.price.product.provider
          ) {
            throw new Error(
              'Cannot redeem a code for a different provider than your current membership. '
            );
          }

          if (activeUserMembership) {
            const membershipProductMetadata = activeUserMembership.product
              .metadata as SubscriptionProductMetadata;

            if (consumedProductMetadata.tier === 'free' || !consumedProductMetadata.tier) {
              throw new Error('Cannot redeem a code for a free or undefined tier');
            }

            const membershipTierOrder = constants.memberships.tierOrder.indexOf(
              membershipProductMetadata.tier
            );
            const consumedTierOrder = constants.memberships.tierOrder.indexOf(
              consumedProductMetadata.tier
            );

            const subscriptionMetadata = (activeUserMembership.metadata ??
              {}) as SubscriptionMetadata;

            // At this point, we can safely extend or improve the membership:
            if (consumedTierOrder === membershipTierOrder) {
              // If it's the same tier, we just extend the current period:
              // Do NOT grant buzz immediately - all tokens go to prepaids
              await tx.customerSubscription.update({
                where: { id: activeUserMembership.id },
                data: {
                  metadata: {
                    ...subscriptionMetadata,
                    prepaids: {
                      ...subscriptionMetadata.prepaids,
                      [consumedProductTier]:
                        (subscriptionMetadata.prepaids?.[consumedProductTier] ?? 0) +
                        consumedCode.unitValue, // All tokens go to prepaids, no immediate buzz
                    },
                    // Do NOT add to buzzTransactionIds since no buzz is granted
                  },
                  status: 'active',
                  currentPeriodEnd: dayjs(activeUserMembership.currentPeriodEnd)
                    .add(
                      consumedCode.unitValue,
                      consumedCode.price.interval as 'day' | 'month' | 'year'
                    )
                    .toDate(),
                },
              });
              // shouldGrantBuzzImmediately remains false for same tier
            } else if (consumedTierOrder > membershipTierOrder) {
              // Upgrade to higher tier - grant buzz immediately
              const now = dayjs();
              const proratedDays =
                dayjs(activeUserMembership.currentPeriodEnd).diff(now, 'days') -
                Number(
                  subscriptionMetadata.prepaids?.[membershipProductMetadata.tier ?? 'free'] ?? 0
                ) *
                  30;

              await tx.customerSubscription.update({
                where: { id: activeUserMembership.id },
                data: {
                  productId: consumedCode.price.product.id,
                  priceId: consumedCode.price.id,
                  status: 'active',
                  currentPeriodStart: now.toDate(),
                  currentPeriodEnd: now
                    .add(
                      consumedCode.unitValue,
                      consumedCode.price.interval as 'day' | 'month' | 'year'
                    )
                    .toDate(),
                  metadata: {
                    ...subscriptionMetadata,
                    prepaids: {
                      ...subscriptionMetadata.prepaids,
                      [consumedProductTier]:
                        (subscriptionMetadata.prepaids?.[consumedProductTier] ?? 0) +
                        consumedCode.unitValue -
                        1, //  First one is granted immediately
                    },
                    proratedDays: {
                      ...subscriptionMetadata.proratedDays,
                      [membershipProductMetadata.tier ?? 'free']:
                        (subscriptionMetadata?.proratedDays?.[
                          membershipProductMetadata.tier ?? 'free'
                        ] ?? 0) + Math.max(0, proratedDays),
                    },
                    buzzTransactionIds: [
                      ...(subscriptionMetadata.buzzTransactionIds ?? []),
                      externalTransactionId,
                    ],
                  },
                },
              });
              shouldGrantBuzzImmediately = true; // Upgrade grants buzz immediately
            } else {
              // Downgrade (user has higher tier) - do NOT grant buzz immediately
              // The system will handle the downgrade logic automatically when the time comes.
              // All tokens go to prepaids for the lower tier
              await tx.customerSubscription.update({
                where: { id: activeUserMembership.id },
                data: {
                  metadata: {
                    ...subscriptionMetadata,
                    prepaids: {
                      ...subscriptionMetadata.prepaids,
                      [consumedProductTier]:
                        (subscriptionMetadata.prepaids?.[consumedProductTier] ?? 0) +
                        consumedCode.unitValue, // All tokens go to prepaids, no immediate buzz
                    },
                    // Do NOT add to buzzTransactionIds since no buzz is granted
                  },
                },
              });
              // shouldGrantBuzzImmediately remains false for downgrade
            }
          }
        }

        if (!activeUserMembership) {
          // Create a new membership - grant buzz immediately for new users
          const now = dayjs();
          const metadata = {
            prepaids: {
              [consumedProductTier]: consumedCode.unitValue - 1, // -1 because we grant buzz right away
            },
            buzzTransactionIds: [externalTransactionId],
          };

          await tx.customerSubscription.create({
            data: {
              id: `redeemable-code-${consumedCode.code}`,
              userId: userId,
              productId: consumedCode.price.product.id,
              priceId: consumedCode.price.id,
              status: 'active',
              currentPeriodStart: now.toDate(),
              currentPeriodEnd: now
                .add(
                  consumedCode.unitValue,
                  consumedCode.price.interval as 'day' | 'month' | 'year'
                )
                .toDate(),
              cancelAtPeriodEnd: true, // We assume they want to cancel at the end of the period
              cancelAt: null, // No cancellation date yet
              metadata: metadata ?? {},
              createdAt: now.toDate(),
            },
          });
          shouldGrantBuzzImmediately = true; // New user gets buzz immediately
        }

        // Only grant buzz immediately for new users and upgrades
        // Same tier extensions and downgrades do NOT get immediate buzz
        if (shouldGrantBuzzImmediately) {
          await withRetries(async () => {
            // Grant buzz right away:
            await createBuzzTransaction({
              fromAccountId: 0,
              toAccountId: userId,
              toAccountType: (consumedProductMetadata.buzzType as any) ?? 'yellow', // Default to yellow if not specified
              type: TransactionType.Purchase,
              externalTransactionId: externalTransactionId,
              amount: Number(consumedProductMetadata.monthlyBuzz ?? 5000), // Default to 5000 if not specified
              description: `Membership bonus`,
              details: {
                type: 'membership-purchase',
                date: date,
                productId: consumedCode.price!.product.id,
              },
            });

            await deliverMonthlyCosmetics({
              userIds: [userId],
              tx,
            });
          });
        }
      }

      return consumedCode;
    },
    {
      // In prod it should hopefully be fast enough but better save than sorry
      timeout: 30000, // 30 seconds timeout for the transaction
    }
  );

  if (consumedCode.type === RedeemableCodeType.Membership) {
    await invalidateSubscriptionCaches(userId);

    const consumedProductMetadata = consumedCode.price?.product
      .metadata as SubscriptionProductMetadata;

    if (consumedProductMetadata) {
      await updateServiceTier({
        userId,
        serviceTier: consumedProductMetadata.tier ?? null,
      });
    }
  }

  // Calculate Buzz value and get matching gift notices
  const tierName =
    consumedCode.type === RedeemableCodeType.Membership
      ? (consumedCode.price?.product?.metadata as SubscriptionProductMetadata)?.tier
      : undefined;

  const buzzValue = convertCodeValueToBuzz(consumedCode.type, consumedCode.unitValue, tierName);

  // Get matching gift notices
  const giftNotices = await getMatchingGiftNotices(buzzValue);

  // Return consumed code with gift notices
  return {
    ...consumedCode,
    giftNotices,
  };
}

/**
 * Gets all gift notices for admin management
 */
export async function getAllGiftNotices(): Promise<Array<GiftNotice & { id: string }>> {
  const noticesRecord = await dbRead.keyValue.findUnique({
    where: { key: KEY_VALUE_KEYS.REDEEM_CODE_GIFT_NOTICES },
  });

  if (!noticesRecord?.value) {
    return [];
  }

  const allNotices = noticesRecord.value as Array<GiftNotice & { id: string }>;
  return allNotices;
}

/**
 * Upserts a gift notice (create or update)
 */
export async function upsertGiftNotice(input: UpsertGiftNoticeInput): Promise<void> {
  const noticesRecord = await dbRead.keyValue.findUnique({
    where: { key: KEY_VALUE_KEYS.REDEEM_CODE_GIFT_NOTICES },
  });

  const existingNotices = (noticesRecord?.value as Array<GiftNotice & { id: string }>) || [];

  // Convert dates to ISO strings for storage
  const notice = {
    id: input.id || generateToken(12),
    startDate: input.startDate.toISOString(),
    endDate: input.endDate.toISOString(),
    minValue: input.minValue,
    maxValue: input.maxValue,
    title: input.title,
    message: input.message,
    linkUrl: input.linkUrl,
    linkText: input.linkText,
  };

  let updatedNotices;
  if (input.id) {
    // Update existing notice
    updatedNotices = existingNotices.map((n) => (n.id === input.id ? notice : n));
  } else {
    // Add new notice
    updatedNotices = [...existingNotices, notice];
  }

  await dbWrite.keyValue.upsert({
    where: { key: KEY_VALUE_KEYS.REDEEM_CODE_GIFT_NOTICES },
    create: {
      key: KEY_VALUE_KEYS.REDEEM_CODE_GIFT_NOTICES,
      value: updatedNotices,
    },
    update: {
      value: updatedNotices,
    },
  });
}

/**
 * Deletes a gift notice
 */
export async function deleteGiftNotice(input: DeleteGiftNoticeInput): Promise<void> {
  const noticesRecord = await dbRead.keyValue.findUnique({
    where: { key: KEY_VALUE_KEYS.REDEEM_CODE_GIFT_NOTICES },
  });

  if (!noticesRecord?.value) {
    throw new Error('No gift notices found');
  }

  const existingNotices = noticesRecord.value as Array<GiftNotice & { id: string }>;
  const updatedNotices = existingNotices.filter((n) => n.id !== input.id);

  await dbWrite.keyValue.update({
    where: { key: KEY_VALUE_KEYS.REDEEM_CODE_GIFT_NOTICES },
    data: {
      value: updatedNotices,
    },
  });
}
