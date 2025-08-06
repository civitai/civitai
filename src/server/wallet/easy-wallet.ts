import type { EvmServerAccount, EvmSmartAccount } from '@coinbase/cdp-sdk';
import { dbWrite } from '~/server/db/client';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';
import { checkOnrampStatus, getOnrampUrl } from '../coinbase/onramp';

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
      const { getZkp2pOnrampUrl } = await import('../zkp2p/zkp2p-onramp');
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
      const { checkZkp2pOnrampStatus } = await import('../zkp2p/zkp2p-onramp');
      return checkZkp2pOnrampStatus(key, this.userId, () => this.getUSDCBalance());
    }

    // Default to Coinbase status check
    return checkOnrampStatus(key);
  }

  async markZkp2pTransactionComplete(key: string, txHash?: string) {
    const { markZkp2pTransactionComplete } = await import('../zkp2p/zkp2p-onramp');
    return markZkp2pTransactionComplete(key, this.userId, txHash);
  }

  // Delegate wallet operations to the CoinbaseWallet
  async listAssets() {
    const { CoinbaseWallet } = await import('../coinbase/coinbase');
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.listAssets();
  }

  async getUSDCBalance() {
    const { CoinbaseWallet } = await import('../coinbase/coinbase');
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.getUSDCBalance();
  }

  async sweepBalance() {
    const { CoinbaseWallet } = await import('../coinbase/coinbase');
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.sweepBalance();
  }

  async sendUSDC(value: number | bigint, key?: string) {
    const { CoinbaseWallet } = await import('../coinbase/coinbase');
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.sendUSDC(value, key);
  }

  async checkTxComplete(txHash: `0x${string}`) {
    const { CoinbaseWallet } = await import('../coinbase/coinbase');
    const coinbaseWallet = new CoinbaseWallet({
      userId: this.userId,
      account: this.account,
      smartAccount: this.smartAccount,
    });
    return coinbaseWallet.checkTxComplete(txHash);
  }
}

/*
Example usage:

// Simple usage with unified interface
import { getWalletForUser } from '~/server/wallet';

const wallet = await getWalletForUser(123);

// Generate Coinbase onramp URL (default)
const coinbaseOnramp = await wallet.getOnrampUrl({
  value: 10, // $10 USD
  redirectUrl: 'https://civitai.com/payment/coinbase'
});

// Generate ZKP2P onramp URL
const zkp2pOnramp = await wallet.getOnrampUrl({
  value: 10, // $10 USD
  provider: 'zkp2p',
  redirectUrl: 'https://civitai.com/payment/zkp2p',
  zkp2pOptions: {
    referrer: 'Civitai',
    referrerLogo: 'https://civitai.com/images/logo.png',
    inputCurrency: 'USD',
    paymentPlatform: 'venmo' // optional
  }
});

// Check onramp status (works for both providers)
const status = await wallet.checkOnrampStatus(coinbaseOnramp.key);
const zkp2pStatus = await wallet.checkOnrampStatus(zkp2pOnramp.key);

// For ZKP2P, manually mark transaction complete when callback is received
await wallet.markZkp2pTransactionComplete(zkp2pOnramp.key, 'optional-tx-hash');

// Alternative: use ZKP2P service functions directly
import { markZkp2pTransactionComplete, handleZkp2pCallback } from '~/server/wallet';
await markZkp2pTransactionComplete(zkp2pOnramp.key, 123, 'optional-tx-hash');
// Or use the convenience callback handler
await handleZkp2pCallback(123, zkp2pOnramp.key, 'optional-tx-hash');
*/
