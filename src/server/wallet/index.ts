import { EasyWallet } from './easy-wallet';
import { getWalletForUser as getCoinbaseWallet } from '../coinbase/coinbase';

/**
 * Get an EasyWallet instance for a user that supports multiple onramp providers
 */
export async function getWalletForUser(userId: number): Promise<EasyWallet> {
  const coinbaseWallet = await getCoinbaseWallet(userId);

  return new EasyWallet({
    userId: coinbaseWallet.userId,
    account: coinbaseWallet.account,
    smartAccount: coinbaseWallet.smartAccount,
  });
}

export { EasyWallet } from './easy-wallet';
export type {
  OnrampProvider,
  OnrampStatus,
  OnrampPaymentMethod,
  ZkP2POptions,
} from './easy-wallet';

// Re-export ZKP2P service functions for convenience
export { getZkp2pOnrampUrl, checkZkp2pOnrampStatus } from '../zkp2p/zkp2p-onramp';
