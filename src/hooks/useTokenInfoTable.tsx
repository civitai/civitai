import { type TokenMetas } from '~/types/mint';
import { Text } from '@mantine/core';
import { type Props as DescriptionTableProps } from '~/components/DescriptionTable/DescriptionTable';
import { openEtherscan } from '~/utils/chain';
import { shortenIfAddress } from '~/utils/address';
import { useMemo } from 'react';

/**
 * A hook that returns information about a given token.
 * @param tokenInfo - An object containing information about a token.
 * @returns An object containing keys and values for a token's name, symbol, and address.
 */
export function useTokenInfoTable(tokenInfo: TokenMetas) {
  const validTokenInfo = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(tokenInfo).filter(
          ([, value]) => value?.name && value?.symbol && value?.address
        )
      ),
    [tokenInfo]
  );

  const values: DescriptionTableProps['items'][] = Object.values(validTokenInfo).map((token) => [
    {
      label: 'Name',
      value: (
        <Text
          style={{
            cursor: 'pointer',
          }}
          td="underline"
          onClick={() => openEtherscan(token?.address || '', 'token')}
        >
          {token.name}
        </Text>
      ),
      visible: true,
    },
    {
      label: 'Symbol',
      value: token.symbol,
      visible: true,
    },
    {
      label: 'Address',
      value: (
        <Text
          style={{
            cursor: 'pointer',
          }}
          td="underline"
          onClick={() => openEtherscan(token?.address || '', 'token')}
        >
          {shortenIfAddress(token?.address || '')}
        </Text>
      ),
      visible: true,
    },
  ]);

  return {
    keys: Object.keys(validTokenInfo),
    values: values,
  };
}
