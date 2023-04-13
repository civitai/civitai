import { getAddress, isAddress } from 'ethers/lib/utils.js';
import { useToken, useContractReads, erc721ABI, type Address } from 'wagmi';
import { type TokenMetas, TokenStandard, type TokensProps } from '~/types/mint';
import { getDefaultChain } from '~/utils/chain';

/**
 * A hook that returns information about a given token.
 * @param tokens An object containing the addresses of the ERC20 and/or ERC721 tokens to retrieve information for.
 * @returns An object containing the names, symbols, and addresses of ERC20 and ERC721 tokens.
 */
export function useTokenInfo(tokens: TokensProps): TokenMetas {
  const getRealAddress = (address?: Address) =>
    address && isAddress(address) ? getAddress(address) : undefined;

  const chainId = getDefaultChain().id;

  const { data: dataERC20 } = useToken({
    address: getRealAddress(tokens?.erc20),
    chainId: chainId,
  });

  const { data: dataERC721 } = useContractReads({
    contracts: [
      {
        address: getRealAddress(tokens?.erc721),
        chainId: chainId,
        abi: erc721ABI,
        functionName: 'name',
      },
      {
        address: getRealAddress(tokens?.erc721),
        chainId: chainId,
        abi: erc721ABI,
        functionName: 'symbol',
      },
    ],
  });

  return {
    [TokenStandard.ERC20]: {
      name: dataERC20?.name,
      symbol: dataERC20?.symbol,
      address: dataERC20?.address,
    },
    [TokenStandard.ERC721]: {
      name: dataERC721?.[0],
      symbol: dataERC721?.[1],
      address: tokens?.erc721,
    },
  };
}
