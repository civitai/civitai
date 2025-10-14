import { env } from 'process';
import { logToAxiom } from '../logging/client';
import Decimal from 'decimal.js';
import type { CreateBuzzCharge } from '~/server/schema/coinbase.schema';
import { COINBASE_FIXED_FEE, specialCosmeticRewards } from '~/server/common/constants';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import type { Coinbase } from '~/server/http/coinbase/coinbase.schema';
import { grantBuzzPurchase } from '~/server/services/buzz.service';
import { grantCosmetics } from '~/server/services/cosmetic.service';

const log = async (data: MixedObject) => {
  await logToAxiom({ name: 'coinbase-service', type: 'error', ...data }).catch();
};

export const createBuzzOrder = async (input: CreateBuzzCharge & { userId: number }) => {
  const orderId = `${input.userId}-${input.buzzAmount}-${input.unitAmount}-${new Date().getTime()}`;

  if (input.unitAmount !== input.buzzAmount / 10) {
    // Safeguard against tampering with the amount on the client side
    throw new Error('There was an error while creating your order. Please try again later.');
  }

  const successUrl =
    `${env.NEXTAUTH_URL || ''}/payment/coinbase?` + new URLSearchParams([['orderId', orderId]]);

  const charge = await coinbaseCaller.createCharge({
    name: `Buzz purchase`,
    description: `Buzz purchase for ${input.buzzAmount} BUZZ`,
    pricing_type: 'fixed_price',
    local_price: {
      amount: new Decimal(input.unitAmount + COINBASE_FIXED_FEE).dividedBy(100).toString(), // Nowpayments use actual amount. Not multiplied by 100
      currency: 'USD',
    },
    metadata: {
      userId: input.userId,
      buzzAmount: input.buzzAmount,
      internalOrderId: orderId,
    },
    redirect_url: successUrl,
    cancel_url: env.NEXTAUTH_URL || '',
  });

  if (!charge) {
    throw new Error('Failed to create charge');
  }

  return charge;
};

export const processBuzzOrder = async (eventData: Coinbase.WebhookEventSchema['event']['data']) => {
  try {
    const metadata = eventData.metadata;
    const internalOrderId = metadata?.internalOrderId;

    if (!internalOrderId) {
      throw new Error('Missing required metadata in Coinbase webhook event');
    }

    const [userId, buzzAmount] = internalOrderId?.split('-').map((v) => Number(v));

    if (!userId || !buzzAmount) {
      throw new Error('Invalid userId or buzzAmount from Coinbase webhook event');
    }

    // Grant buzz/cosmetics
    const transactionId = await grantBuzzPurchase({
      userId,
      amount: buzzAmount,
      orderId: internalOrderId,
      externalTransactionId: internalOrderId,
      provider: 'coinbase',
      chargeId: eventData.id,
      type: 'info',
    });

    const cosmeticIds = specialCosmeticRewards.crypto;
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
      transactionId,
      orderId: internalOrderId,
    });

    return {
      userId,
      buzzAmount,
      transactionId,
      message: 'Buzz purchase processed successfully',
    };
  } catch (error) {
    await log({
      message: 'Failed to process Coinbase webhook event',
      error: error instanceof Error ? error.message : String(error),
      event,
    });
    console.error('Error processing Coinbase webhook event:', error);
    throw error; // Re-throw to handle it upstream if needed
  }
};
