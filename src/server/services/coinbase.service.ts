import { env } from 'process';
import { logToAxiom } from '../logging/client';
import Decimal from 'decimal.js';
import type {
  CreateBuzzCharge,
  GetPaginatedUserTransactionHistorySchema,
} from '~/server/schema/coinbase.schema';
import { COINBASE_FIXED_FEE, specialCosmeticRewards } from '~/server/common/constants';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import type { Coinbase } from '~/server/http/coinbase/coinbase.schema';
import { grantBuzzPurchase } from '~/server/services/buzz.service';
import { grantCosmetics } from '~/server/services/cosmetic.service';
import { getWalletForUser } from '~/server/coinbase/coinbase';
import { dbRead, dbWrite } from '~/server/db/client';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import type { Prisma } from '.prisma/client';

const log = async (data: MixedObject) => {
  await logToAxiom({ name: 'coinbase-service', type: 'error', ...data }).catch();
};

export const createBuzzOrder = async (input: CreateBuzzCharge & { userId: number }) => {
  const orderId = `${input.userId}-${input.buzzAmount}-${new Date().getTime()}`;
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

export const createBuzzOrderOnramp = async (input: CreateBuzzCharge & { userId: number }) => {
  // const orderId = `${input.userId}-${input.buzzAmount}-${new Date().getTime()}`;
  const redirectUrl = `${env.NEXTAUTH_URL || ''}/payment/coinbase`;

  const dollarAmount = new Decimal(input.unitAmount + COINBASE_FIXED_FEE).dividedBy(100).toNumber();
  const wallet = await getWalletForUser(input.userId);
  const onrampUrl = await wallet.getOnrampUrl({
    value: dollarAmount,
    redirectUrl,
    buzzAmount: input.buzzAmount,
    successUrl: redirectUrl,
  });

  if (!onrampUrl) {
    throw new Error('Failed to create OnRamp URL');
  }

  return onrampUrl;
};

export const getTransactionStatusByKey = async ({
  userId,
  key,
}: {
  userId: number;
  key: string;
}) => {
  const transaction = await dbWrite.cryptoTransaction.findFirst({
    where: {
      userId,
      key,
    },
  });

  if (!transaction) {
    throw new Error(`Transaction not found for userId: ${userId} and key: ${key}`);
  }

  const wallet = await getWalletForUser(userId);
  if (!wallet) {
    throw new Error(`No wallet found for userId: ${userId}`);
  }

  let nextTransactionStatus: CryptoTransactionStatus = transaction.status;

  // TODO: @lrojas94 - we probably should replace this with a more generic way to handle ramps
  if (transaction.note === 'ZKP2P onramp') {
    // Assume success so that we can check the next step
    nextTransactionStatus = CryptoTransactionStatus.RampSuccess;
  } else if (
    [
      CryptoTransactionStatus.WaitingForRamp,
      CryptoTransactionStatus.RampFailed,
      CryptoTransactionStatus.RampInProgress,
      CryptoTransactionStatus.RampSuccess,
    ].some((s) => s === transaction.status)
  ) {
    const onrampStatus = await wallet.checkOnrampStatus(key);
    if (!onrampStatus) {
      throw new Error(`Failed to retrieve OnRamp status for key: ${key}`);
    }

    nextTransactionStatus =
      onrampStatus.status === 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS'
        ? CryptoTransactionStatus.RampInProgress
        : onrampStatus.status === 'ONRAMP_TRANSACTION_STATUS_SUCCESS'
        ? CryptoTransactionStatus.RampSuccess
        : onrampStatus.status === 'ONRAMP_TRANSACTION_STATUS_FAILED'
        ? CryptoTransactionStatus.RampFailed
        : nextTransactionStatus;
  }

  if (nextTransactionStatus !== transaction.status) {
    await dbWrite.cryptoTransaction.update({
      where: { userId, key },
      data: {
        status: nextTransactionStatus,
        note: `Updated status to ${nextTransactionStatus}`,
      },
    });

    if (nextTransactionStatus === CryptoTransactionStatus.RampSuccess) {
      // Attempt to pay out buzz:
      await completeCryptoTransaction({
        userId,
        key,
      });
    }
  }

  if (
    [CryptoTransactionStatus.SweepFailed, CryptoTransactionStatus.WaitingForSweep].some(
      (s) => s === transaction.status
    )
  ) {
    // Re-attempt:
    await completeCryptoTransaction({
      userId,
      key,
    });
  }

  const updatedTransaction = await dbWrite.cryptoTransaction.findFirstOrThrow({
    where: {
      userId,
      key,
    },
  });

  return updatedTransaction.status;
};

const completeCryptoTransaction = async ({ userId, key }: { userId: number; key: string }) => {
  const transaction = await dbWrite.cryptoTransaction.findFirst({
    where: {
      userId,
      key,
      // status: CryptoTransactionStatus.RampSuccess,
    },
  });

  if (!transaction) {
    throw new Error(`Transaction not found for userId: ${userId} and key: ${key}`);
  }

  const wallet = await getWalletForUser(userId);
  if (!wallet) {
    throw new Error(`No wallet found for userId: ${userId}`);
  }

  if (
    [CryptoTransactionStatus.RampSuccess, CryptoTransactionStatus.SweepFailed].some(
      (s) => s === transaction.status
    )
  ) {
    const isComplete = await wallet.sendUSDC(transaction.amount, key);
    if (!isComplete) {
      throw new Error(
        `Failed to complete crypto transaction for userId: ${userId} and key: ${key}`
      );
    }
  }

  // Pay buzz:
  await grantBuzzPurchase({
    amount: Math.floor(transaction.amount * 1000),
    userId,
    externalTransactionId: transaction.key,
    provider: 'coinbase-onramp',
    transactionKey: transaction.key,
  });
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

export const getUserWalletBalance = async (userId: number) => {
  const wallet = await getWalletForUser(userId);
  if (!wallet) {
    throw new Error(`No wallet found for userId: ${userId}`);
  }

  const balance = await wallet.getUSDCBalance();
  if (isNaN(balance) || balance < 0) {
    throw new Error(`Failed to retrieve USDC balance for userId: ${userId}`);
  }

  return {
    userId,
    balance: new Decimal(balance).toNumber(), // Convert from smallest unit to USDC
  };
};

export const getPaginatedUserTransactionHistory = async (
  input: GetPaginatedUserTransactionHistorySchema & { userId: number }
) => {
  const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.CryptoTransactionFindManyArgs['where'] = {
    userId: input.userId,
  };
  if (input.statuses && input.statuses.length) where.status = { in: input.statuses };

  const items = await dbRead.cryptoTransaction.findMany({
    where,
    take,
    skip,
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.cryptoTransaction.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};

export const processUserPendingTransactions = async (userId: number) => {
  const balance = await getUserWalletBalance(userId);
  const wallet = await getWalletForUser(userId);
  if (!wallet) {
    throw new Error(`No wallet found for userId: ${userId}`);
  }
  if (balance.balance <= 0) {
    console.log(`No USDC balance for userId: ${userId}`);
    return;
  }

  // Use the wallet balance to determine how much Buzz to send
  const usdcAmount = balance.balance;
  const buzzAmount = Math.floor(usdcAmount * 1000); // 1 USDC = 1000 Buzz

  // Generate a unique key for this transaction
  const transactionKey = `manual-process-${userId}-${new Date().getTime()}`;

  // First, send the USDC from the wallet
  const isComplete = await wallet.sendUSDC(usdcAmount, transactionKey);
  if (!isComplete) {
    throw new Error(`Failed to send USDC for userId: ${userId}`);
  }

  // Create a transaction record for tracking
  await dbWrite.cryptoTransaction.create({
    data: {
      key: transactionKey,
      userId,
      status: CryptoTransactionStatus.Complete,
      amount: usdcAmount,
      note: 'Manual processing of wallet balance',
    },
  });

  // Grant the buzz to the user
  await grantBuzzPurchase({
    amount: buzzAmount,
    userId,
    externalTransactionId: transactionKey,
    provider: 'coinbase-onramp',
    transactionKey,
  });

  console.log(
    `Successfully processed ${usdcAmount} USDC -> ${buzzAmount} Buzz for userId: ${userId}`
  );

  const updatedBalance = await getUserWalletBalance(userId);
  return {
    userId,
    balance: updatedBalance.balance,
    message: 'Processed user pending transactions successfully',
  };
};
