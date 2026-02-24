import { env } from 'process';
import { logToAxiom } from '../logging/client';
import Decimal from 'decimal.js';
import type {
  CreateBuzzCharge,
  CreateCodeOrder,
  GetCodeOrder,
} from '~/server/schema/coinbase.schema';
import { COINBASE_FIXED_FEE, specialCosmeticRewards } from '~/server/common/constants';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import type { Coinbase } from '~/server/http/coinbase/coinbase.schema';
import { grantBuzzPurchase } from '~/server/services/buzz.service';
import { grantCosmetics } from '~/server/services/cosmetic.service';
import { dbRead, dbWrite } from '~/server/db/client';
import { createRedeemableCodes } from '~/server/services/redeemableCode.service';
import { RedeemableCodeType, PaymentProvider } from '~/shared/utils/prisma/enums';

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
      eventData,
    });
    console.error('Error processing Coinbase webhook event:', error);
    throw error; // Re-throw to handle it upstream if needed
  }
};

export const createCodeOrder = async (input: CreateCodeOrder & { userId: number }) => {
  let unitValue: number;
  let priceId: string | undefined;
  let unitAmount: number;
  let codeType: RedeemableCodeType;
  let description: string;

  if (input.type === 'Buzz') {
    unitValue = input.buzzAmount;
    unitAmount = input.buzzAmount / 10; // Price in cents: 10K buzz = $10
    codeType = RedeemableCodeType.Buzz;
    description = `${input.buzzAmount.toLocaleString()} Buzz Redeemable Code`;
  } else {
    // Membership: look up the Price record
    const product = await dbRead.product.findFirst({
      where: {
        provider: PaymentProvider.Civitai,
        metadata: { path: ['tier'], equals: input.tier },
        active: true,
      },
      select: {
        id: true,
        prices: {
          where: { active: true, interval: 'month' },
          select: { id: true, unitAmount: true },
          take: 1,
        },
      },
    });

    if (!product || product.prices.length === 0) {
      throw new Error('No active price found for ' + input.tier + ' membership');
    }

    const price = product.prices[0];
    priceId = price.id;
    unitValue = input.months;
    unitAmount = (price.unitAmount ?? 0) * input.months;
    codeType = RedeemableCodeType.Membership;
    description =
      input.tier.charAt(0).toUpperCase() +
      input.tier.slice(1) +
      ' Membership - ' +
      input.months +
      ' Month' +
      (input.months > 1 ? 's' : '') +
      ' Redeemable Code';
  }

  const orderId = `code-${input.userId}-${Date.now()}`;

  const successUrl =
    `${env.NEXTAUTH_URL || ''}/payment/coinbase-code?` +
    new URLSearchParams([['orderId', orderId]]);

  const charge = await coinbaseCaller.createCharge({
    name: 'Redeemable Code Purchase',
    description,
    pricing_type: 'fixed_price',
    local_price: {
      amount: new Decimal(unitAmount + COINBASE_FIXED_FEE).dividedBy(100).toString(),
      currency: 'USD',
    },
    metadata: {
      userId: input.userId,
      internalOrderId: orderId,
      orderType: 'redeemable_code',
      codeType,
      codeUnitValue: unitValue,
      codePriceId: priceId,
    },
    redirect_url: successUrl,
    cancel_url: `${env.NEXTAUTH_URL || ''}/gift-cards?vendor=crypto`,
  });

  if (!charge) {
    throw new Error('Failed to create charge');
  }

  return charge;
};

export const processCodeOrder = async (eventData: Coinbase.WebhookEventSchema['event']['data']) => {
  try {
    const metadata = eventData.metadata;
    const internalOrderId = metadata?.internalOrderId;
    // CoinBase returns all metadata values as strings - coerce types
    const rawCodeType = String(metadata?.codeType ?? '');
    const codeUnitValue = Number(metadata?.codeUnitValue);
    const codePriceId =
      metadata?.codePriceId && String(metadata.codePriceId) !== 'undefined'
        ? String(metadata.codePriceId)
        : undefined;

    // Validate codeType against enum
    const codeType = Object.values(RedeemableCodeType).includes(rawCodeType as RedeemableCodeType)
      ? (rawCodeType as RedeemableCodeType)
      : undefined;

    if (!internalOrderId || !codeType || !codeUnitValue || isNaN(codeUnitValue)) {
      throw new Error('Missing or invalid metadata for code order in webhook event');
    }

    // Idempotency: check if code was already created for this order (sourceOrderId is unique)
    const existing = await dbRead.redeemableCode.findUnique({
      where: { sourceOrderId: internalOrderId },
      select: { code: true },
    });

    if (existing) {
      await log({
        type: 'info',
        message: 'Code order already processed, skipping',
        orderId: internalOrderId,
      });
      return { orderId: internalOrderId, code: existing.code, status: 'already_completed' };
    }

    // Generate code and link to order atomically
    const code = await dbWrite.$transaction(async (tx) => {
      const codes = await createRedeemableCodes({
        unitValue: codeUnitValue,
        type: codeType,
        priceId: codePriceId,
        quantity: 1,
      });

      const generatedCode = codes[0];

      await tx.redeemableCode.update({
        where: { code: generatedCode },
        data: { sourceOrderId: internalOrderId },
      });

      return generatedCode;
    });

    await log({
      type: 'info',
      message: 'Code order completed successfully',
      orderId: internalOrderId,
      code,
    });

    return { orderId: internalOrderId, code, status: 'completed' };
  } catch (error) {
    await log({
      message: 'Failed to process code order',
      error: error instanceof Error ? error.message : String(error),
      eventData,
    });
    console.error('Error processing code order:', error);
    throw error;
  }
};

export const getCodeOrder = async (input: GetCodeOrder & { userId: number }) => {
  // Verify ownership: orderId format is code-{userId}-{timestamp} (validated by schema regex)
  const match = input.orderId.match(/^code-(\d+)-\d+$/);
  if (!match || Number(match[1]) !== input.userId) {
    throw new Error('Not authorized to view this order');
  }

  const redeemableCode = await dbRead.redeemableCode.findUnique({
    where: { sourceOrderId: input.orderId },
    select: {
      code: true,
      type: true,
      unitValue: true,
      createdAt: true,
    },
  });

  if (!redeemableCode) {
    // Code not yet generated (webhook hasn't fired or is still processing)
    return {
      orderId: input.orderId,
      status: 'pending' as const,
      redeemableCode: null,
      type: null,
      unitValue: null,
    };
  }

  return {
    orderId: input.orderId,
    status: 'completed' as const,
    redeemableCode: redeemableCode.code,
    type: redeemableCode.type,
    unitValue: redeemableCode.unitValue,
  };
};
