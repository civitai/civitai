import type { IconProps } from '@tabler/icons-react';
import React from 'react';
import { CurrencyConfig } from '~/server/common/constants';
import type { BuzzSpendType } from '~/server/schema/buzz.schema';
import { Currency } from '~/shared/utils/prisma/enums';

type Props = IconProps & {
  currency?: Currency;
  type?: BuzzSpendType;
};

export function CurrencyIcon({ currency = Currency.BUZZ, type, ...iconProps }: Props) {
  const config =
    currency === Currency.BUZZ && type
      ? CurrencyConfig.BUZZ.themes[type]
      : CurrencyConfig[currency];
  const Icon = config.icon;

  // TODO: Add tooltip: this action will cost <CURRENCY>

  return <Icon color={config.color} fill={config.fill ?? 'transparent'} {...iconProps} />;
}
