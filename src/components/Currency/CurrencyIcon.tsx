import { useMantineTheme } from '@mantine/core';
import type { IconProps } from '@tabler/icons-react';
import React from 'react';
import { CurrencyConfig } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';

type Props = IconProps & {
  currency?: Currency;
  type?: string;
};

export function CurrencyIcon({ currency = Currency.BUZZ, type, ...iconProps }: Props) {
  const theme = useMantineTheme();
  const config = CurrencyConfig[currency].themes?.[type ?? ''] ?? CurrencyConfig[currency];
  const Icon = config.icon;

  // TODO: Add tooltip: this action will cost <CURRENCY>

  return (
    <Icon color={config.color(theme)} fill={config.fill?.(theme) ?? 'transparent'} {...iconProps} />
  );
}
