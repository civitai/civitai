import { Address } from 'wagmi';

export enum TokenStandard {
  ERC20 = 'ERC20',
  ERC721 = 'ERC721',
}

export type TokenMeta = {
  name?: string;
  symbol?: string;
  address?: Address;
};

export type TokenMetas = {
  [TokenStandard.ERC20]: TokenMeta;
  [TokenStandard.ERC721]: TokenMeta;
};

export type TokensProps = {
  erc20?: Address;
  erc721?: Address;
} | null;
