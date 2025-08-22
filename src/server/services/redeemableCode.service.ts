import dayjs from '~/shared/utils/dayjs';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import type {
  ConsumeRedeemableCodeInput,
  CreateRedeemableCodeInput,
  DeleteRedeemableCodeInput,
} from '~/server/schema/redeemableCode.schema';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';
import { createBuzzTransaction, getMultipliersForUser } from '~/server/services/buzz.service';
import { throwDbCustomError, withRetries } from '~/server/utils/errorHandling';
import { invalidateSession } from '~/server/utils/session-helpers';
import { PaymentProvider, RedeemableCodeType } from '~/shared/utils/prisma/enums';
import { generateToken } from '~/utils/string-helpers';
import { deliverMonthlyCosmetics } from './subscriptions.service';
import { setVaultFromSubscription } from '~/server/services/vault.service';
import { updateServiceTier } from '~/server/integrations/freshdesk';

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
    where: { code, redeemedAt: null },
    select: {
      code: true,
      type: true,
      price: {
        select: {
          product: {
            select: {
              provider: true,
            },
          },
        },
      },
    },
  });

  if (!codeRecord) {
    throw new Error('Code does not exist or has been redeemed');
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
      const consumedCode = await tx.redeemableCode
        .update({
          where: {
            code,
            redeemedAt: null,
            OR: [{ expiresAt: { gt: new Date() } }, { expiresAt: null }],
          },
          data: { redeemedAt: new Date(), userId },
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
          },
        })
        .catch(throwDbCustomError('Code does not exist, has been redeemed, or has expired'));

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
          where: { userId },
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

        const consumedProductMetadata = consumedCode.price.product
          .metadata as SubscriptionProductMetadata;
        const consumedProductTier = consumedProductMetadata.tier ?? 'free';

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
              await tx.customerSubscription.update({
                where: { id: activeUserMembership.id },
                data: {
                  metadata: {
                    ...subscriptionMetadata,
                    prepaids: {
                      ...subscriptionMetadata.prepaids,
                      [consumedProductTier]:
                        (subscriptionMetadata.prepaids?.[consumedProductTier] ?? 0) +
                        consumedCode.unitValue,
                    },
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
            } else if (consumedTierOrder > membershipTierOrder) {
              const now = dayjs();
              console.log({ x: dayjs(activeUserMembership.currentPeriodEnd).diff(now, 'days') });
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
                  },
                },
              });
            } else {
              // We'll only update the metadata for downgrades.
              // The system will handle the downgrade logic automatically when the time comes.
              await tx.customerSubscription.update({
                where: { id: activeUserMembership.id },
                data: {
                  metadata: {
                    ...subscriptionMetadata,
                    prepaids: {
                      ...subscriptionMetadata.prepaids,
                      [consumedProductTier]:
                        (subscriptionMetadata.prepaids?.[consumedProductTier] ?? 0) +
                        consumedCode.unitValue,
                    },
                  },
                },
              });
            }
          }
        }

        if (!activeUserMembership) {
          // Create a new membership:
          const now = dayjs();
          const metadata = {
            prepaids: {
              [consumedProductTier]: consumedCode.unitValue - 1, // -1 because we grant buzz right away
            },
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
        }

        const date = dayjs().format('YYYY-MM');

        await withRetries(async () => {
          // Grant buzz right away:
          await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: userId,
            type: TransactionType.Purchase,
            externalTransactionId: `civitai-membership:${date}:${userId}:${
              consumedCode.price!.product.id
            }`,
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

      return consumedCode;
    },
    {
      // In prod it should hopefully be fast enough but better save than sorry
      timeout: 10000, // 10 seconds timeout for the transaction
    }
  );

  if (consumedCode.type === RedeemableCodeType.Membership) {
    await invalidateSession(userId);
    await getMultipliersForUser(userId, true);
    await setVaultFromSubscription({
      userId,
    });

    const consumedProductMetadata = consumedCode.price?.product
      .metadata as SubscriptionProductMetadata;

    if (consumedProductMetadata) {
      await updateServiceTier({
        userId,
        serviceTier: consumedProductMetadata.tier ?? null,
      });
    }
  }

  return consumedCode;
}
