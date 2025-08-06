import type { EvmServerAccount, EvmSmartAccount } from '@coinbase/cdp-sdk';
import { dbWrite } from '~/server/db/client';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';
import { checkOnrampStatus, getOnrampUrl } from '../coinbase/onramp';
import { getZkp2pOnrampUrl, checkZkp2pOnrampStatus } from '../zkp2p/zkp2p-onramp';
import { CoinbaseWallet } from '../coinbase/coinbase';

export type OnrampProvider = 'coinbase' | 'zkp2p';

export type OnrampStatus =
  | 'ONRAMP_TRANSACTION_STATUS_SUCCESS'
  | 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS'
  | 'ONRAMP_TRANSACTION_STATUS_FAILED';

export type OnrampPaymentMethod =
  | 'CARD'
  | 'ACH_BANK_ACCOUNT'
  | 'APPLE_PAY'
  | 'FIAT_WALLET'
  | 'CRYPTO_WALLET'
  | 'ZKP2P';

export interface ZkP2POptions {
  referrer?: string;
  referrerLogo?: string;
  inputCurrency?: string;
  inputAmount?: number;
  paymentPlatform?: string;
  amountUsdc?: string;
  toToken?: string;
}

export class EasyWallet {
  userId: number;
  account: EvmServerAccount;
  smartAccount: EvmSmartAccount;

  constructor({
    userId,
    account,
    smartAccount,
  }: {
    userId: number;
    account: EvmServerAccount;
    smartAccount: EvmSmartAccount;
  }) {
    this.userId = userId;
    this.account = account;
    this.smartAccount = smartAccount;
    console.log(
      `EasyWallet Initialized:\nUser ID: ${userId}\nAccount Address: ${account.address}\nSmart Account Address: ${smartAccount.address}`
    );
  }

  async getOnrampUrl({
    value,
    redirectUrl = 'https://civitai.com/payment/coinbase',
    provider = 'coinbase',
    zkp2pOptions = {},
    ...passthrough
  }: {
    value: number;
    redirectUrl?: string;
    provider?: OnrampProvider;
    zkp2pOptions?: ZkP2POptions;
  } & MixedObject) {
    let url: string;
    let key: string;

    if (provider === 'zkp2p') {
      const zkp2pResult = getZkp2pOnrampUrl({
        address: this.smartAccount.address,
        value,
        userId: this.userId,
        redirectUrl: redirectUrl.replace('/coinbase', '/zkp2p'),
        zkp2pOptions,
      });
      url = zkp2pResult.url;
      key = zkp2pResult.key;
    } else {
      // Default to Coinbase
      const coinbaseResult = await getOnrampUrl({
        address: this.smartAccount.address,
        value,
        userId: this.userId,
        redirectUrl,
        ...passthrough,
      });
      url = coinbaseResult.url;
      key = coinbaseResult.key;
    }

    await dbWrite.cryptoTransaction.create({
      data: {
        key,
        userId: this.userId,
        status: CryptoTransactionStatus.WaitingForRamp,
        amount: value,
        currency: 'USDC',
        note: provider === 'zkp2p' ? 'ZKP2P onramp' : 'Coinbase onramp',
      },
    });

    return { url, key, provider };
  }

  async checkOnrampStatus(key: string) {
    // Check if this is a ZKP2P transaction based on the key prefix
    if (key.startsWith('zkp2p-')) {
      return checkZkp2pOnrampStatus(key, this.userId, () => this.getUSDCBalance());
    }

    // Default to Coinbase status check
    return checkOnrampStatus(key);
  }

  // Delegate wallet operations to the CoinbaseWallet
  async listAssets() {
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.listAssets();
  }

  async getUSDCBalance() {
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.getUSDCBalance();
  }

  async sweepBalance() {
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.sweepBalance();
  }

  async sendUSDC(value: number | bigint, key?: string) {
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.sendUSDC(value, key);
  }

  async checkTxComplete(txHash: `0x${string}`) {
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.checkTxComplete(txHash);
  }
}
