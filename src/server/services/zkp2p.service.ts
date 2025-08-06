import { Decimal } from '@prisma/client/runtime/library';
import { CryptoTransactionStatus } from '@prisma/client';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { getWalletForUser } from '~/server/wallet';
import { grantBuzzPurchase } from '~/server/services/buzz.service';

export type CreateBuzzCharge = {
  buzzAmount: number;
  unitAmount: number;
};

// ZKP2P has no fixed fees, unlike Coinbase
const ZKP2P_FIXED_FEE = 0;

export const createBuzzOrderOnramp = async (input: CreateBuzzCharge & { userId: number }) => {
  const redirectUrl = `${env.NEXTAUTH_URL}/payment/zkp2p`;

  const dollarAmount = new Decimal(input.unitAmount + ZKP2P_FIXED_FEE).dividedBy(100).toNumber();
  const wallet = await getWalletForUser(input.userId);
  const onrampUrl = await wallet.getOnrampUrl({
    value: dollarAmount,
    redirectUrl,
    buzzAmount: input.buzzAmount,
    successUrl: redirectUrl,
    provider: 'zkp2p',
  });

  if (!onrampUrl) {
    throw new Error('Failed to create ZKP2P OnRamp URL');
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

  if (
    [
      CryptoTransactionStatus.WaitingForRamp,
      CryptoTransactionStatus.RampFailed,
      CryptoTransactionStatus.RampInProgress,
      CryptoTransactionStatus.RampSuccess,
    ].some((s) => s === transaction.status)
  ) {
    const onrampStatus = await wallet.checkOnrampStatus(key);
    if (!onrampStatus) {
      throw new Error(`Failed to retrieve ZKP2P OnRamp status for key: ${key}`);
    }

    // ZKP2P uses the same status values as Coinbase
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
    where: { userId, key },
  });

  return {
    ...updatedTransaction,
    status: nextTransactionStatus,
  };
};

const completeCryptoTransaction = async ({ userId, key }: { userId: number; key: string }) => {
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
    provider: 'zkp2p-onramp',
    transactionKey: transaction.key,
  });
};
