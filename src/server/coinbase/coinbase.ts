import type { EvmServerAccount, EvmSmartAccount } from '@coinbase/cdp-sdk';
import { CdpClient } from '@coinbase/cdp-sdk';
import { createPublicClient, erc20Abi, http, parseUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { checkOnrampStatus, getOnrampUrl } from './onramp';
import type { SendUserOperationReturnType } from '@coinbase/cdp-sdk/_types/actions/evm/sendUserOperation';

// Initialize the CDP client, which automatically loads
// the API Key and Wallet Secret from the environment
export const cdp = new CdpClient();

// Initialize the public client
// This is used to wait for the transaction receipt
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

const constants = {
  usdcAddress: process.env.CDP_USDC_ADDRESS as `0x${string}`,
  network: process.env.CDP_NETWORK! as 'base-sepolia' | 'base',
  paymasterUrl: process.env.CDP_PAYMASTER_URL,
  appId: process.env.CDP_APP_ID!,
  civitaiAddress: process.env.CDP_CIVITAI_ADDRESS as `0x${string}`,
};

export async function getWalletForUser(userId: number) {
  const accountName = `user-${userId}`;
  let createdAccount = false;
  let account: EvmServerAccount | undefined;
  let smartAccount: EvmSmartAccount | undefined;

  try {
    account = await cdp.evm.getAccount({
      name: accountName,
    });
    const { accounts } = await cdp.evm.listSmartAccounts({
      name: accountName,
    });
    smartAccount =
      accounts.length > 0
        ? await cdp.evm.getSmartAccount({
            owner: account,
            address: accounts[0].address,
          })
        : undefined;
  } catch (e) {
    // Account does not exist, create it
  }

  // Create an EVM account
  if (!account) {
    account = await cdp.evm.getOrCreateAccount({
      name: accountName,
    });
  }

  if (!smartAccount) {
    smartAccount = await cdp.evm.createSmartAccount({
      owner: account,
      idempotencyKey: accountName,
    });
    createdAccount = true;
  }

  if (createdAccount) {
    // Request ETH from the faucet - Dev Only
    if (constants.network === 'base-sepolia') {
      const faucetResponse = await cdp.evm.requestFaucet({
        address: account.address,
        network: 'base-sepolia',
        token: 'eth',
      });
      await publicClient.waitForTransactionReceipt({
        hash: faucetResponse.transactionHash,
      });
    }

    // TODO: Add address to database for user
    /*
    dbWrite.cryptoWallet.insert({
      userId,
      wallet: account.address,
      smartAccount: smartAccount.address,
    })
    */
  }

  return new EasyWallet({ userId, account, smartAccount });
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
    // TODO: Add correct redirect URL (page for monitoring tx completion)
    redirectUrl = 'https://civitai.com',
  }: {
    value: number;
    redirectUrl?: string;
  }) {
    const { url, key } = await getOnrampUrl({
      address: this.smartAccount.address,
      value,
      userId: this.userId,
      redirectUrl,
    });

    // TODO: write attempt to database, so we can check if they fall off
    /*
      await dbWrite.cryptoTransaction.create({
        data: {
          key,
          userId,
          status: 'WaitingForRamp',
          amount: value,
          currency: 'USDC',
        }
      })
    */

    return { url, key };
  }

  async checkOnrampStatus(key: string) {
    return checkOnrampStatus(key);
  }

  async listAssets() {
    const assets = await cdp.evm.listTokenBalances({
      address: this.smartAccount.address,
      network: constants.network,
    });
    return assets.balances;
  }

  async getUSDCBalance() {
    const assets = await this.listAssets();
    const usdcBalance = assets.find(
      (asset) =>
        asset.token.contractAddress === constants.usdcAddress &&
        asset.token.network === constants.network
    );
    const amount = usdcBalance?.amount.amount ?? 0;
    return Number(amount) / 10 ** 6; // Convert from wei to USDC (6 decimals)
  }

  async sweepBalance() {
    const assets = await this.listAssets();
    const usdcBalance = assets.find(
      (asset) =>
        asset.token.contractAddress === constants.usdcAddress &&
        asset.token.network === constants.network
    );
    const amount = usdcBalance?.amount.amount;
    if (!amount) {
      console.log('No USDC balance to sweep');
      return false;
    }

    return this.sendUSDC(amount);
  }

  async sendUSDC(value: number | bigint, key?: string) {
    if (value <= 0) throw new Error('Value must be greater than 0');

    // parseUnits if needed
    const preparedValue = typeof value === 'bigint' ? value : parseUnits(value.toString(), 6);
    let result: SendUserOperationReturnType | undefined;
    try {
      result = await cdp.evm.sendUserOperation({
        smartAccount: this.smartAccount,
        network: constants.network,
        paymasterUrl: constants.paymasterUrl,
        calls: [
          {
            to: constants.usdcAddress,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [constants.civitaiAddress, preparedValue],
          },
        ],
      });
      console.log(`Sending ${value} USDC. Tx: ${result.userOpHash}`);

      // TODO: write to database, so we can recover if we die here
      /*
        dbWrite.cryptoTransaction.update({
          where: { userId, key },
          data: {
            status: 'WaitingForSweep',
            sweepTxHash: result.userOpHash,
          }
        })
      */
    } catch (error) {
      console.error('Error sending USDC:', error);
      // TODO: write to database, so we can recover if we die here
      /*
        dbWrite.cryptoTransaction.update({
          where: { userId, key },
          data: {
            status: 'SweepFailed',
            note: error.message,
          }
        })
      */
      throw new Error('Failed to send USDC');
    }

    const userOp = await cdp.evm.waitForUserOperation({
      smartAccountAddress: this.smartAccount.address,
      userOpHash: result.userOpHash,
    });

    // TODO: write to database updated status
    /*
      dbWrite.cryptoTransaction.update({
        where: { userId, key },
        data: {
          status: userOp.status === 'complete'? 'Complete' : 'SweepFailed',
          note: userOp.status === 'complete' ? '' : 'Transaction failed'
        }
      })
    */

    return userOp.status === 'complete';
  }

  async checkTxComplete(txHash: `0x${string}`) {
    const userOp = await cdp.evm.waitForUserOperation({
      smartAccountAddress: this.smartAccount.address,
      userOpHash: txHash,
    });

    if (!userOp) {
      throw new Error(`User operation with hash ${txHash} not found`);
    }

    return userOp.status === 'complete';
  }
}
