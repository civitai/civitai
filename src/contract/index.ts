import { Address } from 'wagmi';
import { getDefaultChain } from '~/utils/chain';
import { mainnet, goerli } from 'wagmi/chains';

export const chain = getDefaultChain();

interface ChainAddress {
  [chainId: number]: Address;
}

// Factory contract address
export const factoryContractMap: ChainAddress = {
  [mainnet.id]: '0x0000000000000000000000000000000000000000',
  [goerli.id]: '0xB36a6C06b47ad1D6637F49Ff390ff79064e6b4e1',
};
export const factoryContract = factoryContractMap[chain.id];
