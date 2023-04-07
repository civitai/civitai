import { Address, goerli, mainnet } from 'wagmi';
import { getDefaultChain } from '~/utils/chain';

export const chain = getDefaultChain();

interface ChainAddress {
  [chainId: number]: Address;
}

// Factory contract address
export const factoryContractMap: ChainAddress = {
  [mainnet.id]: '0x0000000000000000000000000000000000000000',
  [goerli.id]: '0x4ff0E7F1ECb2c64a7E11EB9F03BEd6be792584C2',
};
export const factoryContract = factoryContractMap[chain.id];
