import { Chain, mainnet } from 'wagmi';
import { env } from '~/env/client.mjs';
import { chains } from '~/providers/Web3ModalProvider';

export function getDefaultChain(): Chain {
  const chainId = env.NEXT_PUBLIC_CHAIN_ID;
  const chain = chains.find((c) => c.id === Number(chainId));
  return chain || mainnet;
}

/**
 * Open Ethereum block explorer
 * @param hash
 * @param flag
 */
export function openEtherscan(hash: string, flag: 'tx' | 'address' | 'token' | 'block') {
  const chain = getDefaultChain();
  const url = `${chain.blockExplorers?.etherscan.url}/${flag}/${hash}`;
  window.open(url, '_blank');
}
