import { useMantineTheme } from '@mantine/core';
import { Currency } from '@prisma/client';
import { TablerIconsProps } from '@tabler/icons-react';
import { CurrencyConfig } from '~/server/common/constants';
import React from 'react';

type Props = TablerIconsProps & {
  currency?: Currency;
};

export function CurrencyIcon({ currency = Currency.BUZZ, ...iconProps }: Props) {
  const theme = useMantineTheme();
  const Icon = CurrencyConfig[currency].icon;

  // TODO: Add tooltip: this action will cost <CURRENCY>

  return (
    <Icon
      color={CurrencyConfig[currency].color(theme)}
      fill={CurrencyConfig[currency].fill?.(theme) ?? 'transparent'}
      {...iconProps}
    />
  );
}
