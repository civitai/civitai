import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';

interface ZkP2POptions {
  referrer?: string;
  referrerLogo?: string;
  inputCurrency?: string;
  inputAmount?: number;
  paymentPlatform?: string;
  amountUsdc?: string;
  toToken?: string;
}

type OnrampStatus =
  | 'ONRAMP_TRANSACTION_STATUS_SUCCESS'
  | 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS'
  | 'ONRAMP_TRANSACTION_STATUS_FAILED';

type OnrampPaymentMethod =
  | 'CARD'
  | 'ACH_BANK_ACCOUNT'
  | 'APPLE_PAY'
  | 'FIAT_WALLET'
  | 'CRYPTO_WALLET'
  | 'ZKP2P';

// ZKP2P onramp URL generation
export function getZkp2pOnrampUrl({
  address,
  value,
  userId,
  redirectUrl = 'https://civitai.com/payment/zkp2p',
  zkp2pOptions = {},
}: {
  address: `0x${string}`;
  value: number;
  userId: number;
  redirectUrl?: string;
  zkp2pOptions?: ZkP2POptions;
}) {
  const key = `zkp2p-${userId}-${Date.now()}`;

  // append the key to the redirectUrl so we can track the transaction
  const redirectUrlWithKey = new URL(redirectUrl);
  redirectUrlWithKey.searchParams.set('key', key);
  const finalRedirectUrl = redirectUrlWithKey.toString();

  // Convert value to USDC amount with 6 decimals (1 USDC = 1000000 units)
  const usdcAmount = Math.round(value * 1_000_000).toString();

  // Base chain ID and USDC token address for Base
  const network = env.CDP_NETWORK! as 'base-sepolia' | 'base';
  const baseChainId = network === 'base-sepolia' ? '84532' : '8453';
  const usdcTokenAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base USDC
  const toToken = `${baseChainId}:${usdcTokenAddress}`;

  const params = new URLSearchParams({
    referrer: zkp2pOptions.referrer || 'Civitai',
    referrerLogo:
      zkp2pOptions.referrerLogo || 'https://civitai.com/images/android-chrome-512x512.png',
    callbackUrl: finalRedirectUrl,
    amountUsdc: usdcAmount,
    toToken,
    recipientAddress: address,
    ...Object.fromEntries(
      Object.entries(zkp2pOptions).filter(
        ([key, value]) => !['referrer', 'referrerLogo'].includes(key) && value !== undefined
      )
    ),
  });

  const url = `https://zkp2p.xyz/swap?${params.toString()}`;
  return { url, key };
}

// ZKP2P onramp status checking
export async function checkZkp2pOnrampStatus(
  key: string,
  userId: number,
  getUSDCBalance: () => Promise<number>
) {
  // For ZKP2P, we can't check status via API like Coinbase
  // The status will be updated when the user returns to the callback URL
  // or when we detect the USDC balance change
  const transaction = await dbWrite.cryptoTransaction.findFirst({
    where: { key, userId },
  });

  if (!transaction) {
    return null;
  }

  // If transaction is still waiting for ramp or in progress, check if we received USDC
  if (
    transaction.status === CryptoTransactionStatus.WaitingForRamp ||
    transaction.status === CryptoTransactionStatus.RampInProgress
  ) {
    const currentBalance = await getUSDCBalance();
    // If we have received at least the expected amount, mark as complete
    if (currentBalance >= transaction.amount) {
      await dbWrite.cryptoTransaction.update({
        where: { key, userId },
        data: {
          status: CryptoTransactionStatus.Complete,
          note: 'ZKP2P onramp completed - USDC received',
        },
      });

      return {
        purchaseAmount: transaction.amount,
        purchaseCurrency: 'USD',
        paymentMethod: 'ZKP2P' as OnrampPaymentMethod,
        status: 'ONRAMP_TRANSACTION_STATUS_SUCCESS' as OnrampStatus,
        hash: '0x0' as `0x${string}`, // ZKP2P doesn't provide transaction hash
      };
    }
  }

  return {
    purchaseAmount: transaction.amount,
    purchaseCurrency: 'USD',
    paymentMethod: 'ZKP2P' as OnrampPaymentMethod,
    status: (transaction.status === CryptoTransactionStatus.Complete
      ? 'ONRAMP_TRANSACTION_STATUS_SUCCESS'
      : 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS') as OnrampStatus,
    hash: '0x0' as `0x${string}`,
  };
}

// ZKP2P transaction completion marking
export async function markZkp2pTransactionComplete(key: string, userId: number, txHash?: string) {
  if (!key.startsWith('zkp2p-')) {
    throw new Error('Invalid ZKP2P transaction key');
  }

  const transaction = await dbWrite.cryptoTransaction.findFirst({
    where: { key, userId },
  });

  if (!transaction) {
    throw new Error('Transaction not found');
  }

  await dbWrite.cryptoTransaction.update({
    where: { key, userId },
    data: {
      status: CryptoTransactionStatus.Complete,
      note: `ZKP2P onramp completed${txHash ? ` - tx: ${txHash}` : ''}`,
      sweepTxHash: txHash,
    },
  });

  return true;
}

// ZKP2P callback handler - convenience function for handling callbacks
export async function handleZkp2pCallback(userId: number, key: string, txHash?: string) {
  return markZkp2pTransactionComplete(key, userId, txHash);
}
