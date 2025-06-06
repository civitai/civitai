import { fetchCoinbase } from './coinbase-api';

export type OnrampStatus =
  | 'ONRAMP_TRANSACTION_STATUS_SUCCESS'
  | 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS'
  | 'ONRAMP_TRANSACTION_STATUS_FAILED';
export type OnrampPaymentMethod =
  | 'CARD'
  | 'ACH_BANK_ACCOUNT'
  | 'APPLE_PAY'
  | 'FIAT_WALLET'
  | 'CRYPTO_WALLET';

async function createOnrampSessionToken(address: `0x${string}`) {
  const { token } = await fetchCoinbase({
    method: 'POST',
    path: '/onramp/v1/token',
    body: {
      addresses: [{ address, blockchains: ['base'] }],
      assets: ['USDC'],
    },
  });
  return token;
}

export async function getOnrampUrl({
  address,
  value,
  userId,
  redirectUrl = 'https://civitai.com',
}: {
  address: `0x${string}`;
  value: number;
  userId: number;
  redirectUrl?: string;
}) {
  const token = await createOnrampSessionToken(address);
  const key = `${userId}-${Date.now()}`;

  // append the key to the redirectUrl so we can check the status of the onramp later
  const redirectUrlWithKey = new URL(redirectUrl);
  redirectUrlWithKey.searchParams.set('key', key);
  redirectUrl = redirectUrlWithKey.toString();

  const params = new URLSearchParams({
    sessionToken: token,
    appId: process.env.CDP_APP_ID!,
    presetCryptoAmount: value.toString(),
    defaultExperience: 'buy',
    partnerUserId: key,
    endPartnerName: 'civitai',
    redirectUrl,
  });

  const url = `https://pay.coinbase.com/buy/select-asset?${params.toString()}`;
  return { url, key };
}

type OnrampTransactionResult = {
  purchaseAmount: number;
  purchaseCurrency: string;
  paymentMethod: OnrampPaymentMethod;
  status: OnrampStatus;
  hash: `0x${string}`;
};

export async function checkOnrampStatus(key: string): Promise<OnrampTransactionResult | null> {
  const { transactions } = await fetchCoinbase({
    method: 'GET',
    path: `/onramp/v1/buy/user/${key}/transactions`,
  });

  if (transactions.length === 0) return null;

  return transactions.map(
    (tx: any): OnrampTransactionResult => ({
      purchaseAmount: Number(tx.purchase_amount.value) as number,
      purchaseCurrency: tx.purchase_amount.currency as string,
      paymentMethod: tx.payment_method as OnrampPaymentMethod,
      status: tx.status as OnrampStatus,
      hash: tx.tx_hash as `0x${string}`,
    })
  )[0];
}
