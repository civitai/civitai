import { Decimal } from '@prisma/client/runtime/library';
import { env } from '~/env/server';
import emerchantpayCaller from '~/server/http/emerchantpay/emerchantpay.caller';
import type { EmerchantPay } from '~/server/http/emerchantpay/emerchantpay.schema';
import { logToAxiom } from '~/server/logging/client';
import { grantBuzzPurchase } from '~/server/services/buzz.service';
import { grantCosmetics } from '~/server/services/cosmetic.service';
import { specialCosmeticRewards } from '~/server/common/constants';

// EmerchantPay processing fee (in cents)
const EMERCHANTPAY_FIXED_FEE = 0; // No fixed fee for now

export interface CreateBuzzCharge {
  unitAmount: number;
  buzzAmount: number;
}

const log = async (data: MixedObject) => {
  try {
    await logToAxiom({ name: 'emerchantpay-service', type: 'error', ...data }).catch();
  } catch (error) {
    console.error('Failed to log to Axiom:', error);
  }
};

export const createBuzzOrder = async (input: CreateBuzzCharge & { userId: number }) => {
  const orderId = `${input.userId}-${input.buzzAmount}-${new Date().getTime()}`;
  const successUrl =
    `${env.NEXTAUTH_URL}/payment/emerchantpay?` + new URLSearchParams([['orderId', orderId]]);
  const failureUrl =
    `${env.NEXTAUTH_URL}/payment/emerchantpay?` +
    new URLSearchParams([
      ['orderId', orderId],
      ['error', 'failed'],
    ]);
  const cancelUrl = `${env.NEXTAUTH_URL}/purchase/buzz`;

  // Convert to dollars with fixed fee
  const dollarAmount = new Decimal(input.unitAmount + EMERCHANTPAY_FIXED_FEE)
    .dividedBy(100)
    .toNumber();

  const wpfPayment = await emerchantpayCaller.createWPFPayment({
    transaction_id: orderId,
    usage: `Buzz purchase`,
    description: `Buzz purchase for ${input.buzzAmount} BUZZ`,
    notification_url: `${env.NEXTAUTH_URL}/api/webhooks/emerchantpay`,
    return_success_url: successUrl,
    return_failure_url: failureUrl,
    return_cancel_url: cancelUrl,
    amount: dollarAmount,
    currency: 'USD',
    customer_email: '', // Will be filled by the calling service with user email
    lifetime: 60, // 60 minutes
    transaction_types: [
      {
        name: 'sale',
        digital_asset_type: true,
      },
    ],
    metadata: {
      userId: input.userId,
      internalOrderId: orderId,
      buzzAmount: input.buzzAmount,
    },
  });

  if (!wpfPayment) {
    throw new Error('Failed to create WPF payment');
  }

  return wpfPayment;
};

export const getTransactionStatusByUniqueId = async ({
  userId,
  uniqueId,
}: {
  userId: number;
  uniqueId: string;
}) => {
  try {
    const reconcileResult = await emerchantpayCaller.reconcileWPFPayment(uniqueId);

    return {
      status: reconcileResult.status,
      transaction_id: reconcileResult.transaction_id,
      unique_id: reconcileResult.unique_id,
      amount: reconcileResult.amount,
      currency: reconcileResult.currency,
      timestamp: reconcileResult.timestamp,
    };
  } catch (error) {
    await log({
      message: 'Failed to get transaction status',
      userId,
      uniqueId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const processBuzzOrder = async (
  notification: EmerchantPay.WebhookNotificationSchema
): Promise<{
  userId: number;
  buzzAmount: number;
  transactionId: string;
  message: string;
}> => {
  try {
    const paymentTransaction = notification.payment_transaction;

    if (!paymentTransaction || paymentTransaction.status !== 'approved') {
      throw new Error(`Payment not approved. Status: ${paymentTransaction?.status}`);
    }

    // Extract metadata from transaction_id or use reconcile to get metadata
    const transactionId = paymentTransaction.transaction_id;
    const [userId, buzzAmount] = transactionId.split('-').map((v) => Number(v));

    if (!userId || !buzzAmount) {
      throw new Error('Invalid userId or buzzAmount from EmerchantPay notification');
    }

    // Grant buzz/cosmetics
    const transactionResult = await grantBuzzPurchase({
      userId,
      amount: buzzAmount,
      orderId: transactionId,
      externalTransactionId: transactionId,
      provider: 'emerchantpay',
      chargeId: paymentTransaction.unique_id,
      type: 'info',
    });

    // Use crypto cosmetics for now, can be changed later
    const cosmeticIds = specialCosmeticRewards.crypto || [];
    if (cosmeticIds.length > 0) {
      await grantCosmetics({
        userId,
        cosmeticIds,
      });
    }

    await log({
      message: 'Buzz purchase granted successfully',
      userId,
      buzzAmount,
      transactionId: transactionResult,
      orderId: transactionId,
    });

    return {
      userId,
      buzzAmount,
      transactionId: transactionResult,
      message: 'Buzz purchase processed successfully',
    };
  } catch (error) {
    await log({
      message: 'Failed to process EmerchantPay webhook notification',
      error: error instanceof Error ? error.message : String(error),
      notification,
    });
    console.error('Error processing EmerchantPay webhook notification:', error);
    throw error;
  }
};

export const isAPIHealthy = async (): Promise<boolean | null> => {
  return emerchantpayCaller.isAPIHealthy();
};
