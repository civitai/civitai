import type { IconProps } from '@tabler/icons-react';
import React from 'react';
import { getCurrencyConfig } from '~/server/common/constants';
import type { BuzzSpendType } from '~/server/schema/buzz.schema';
import { Currency } from '~/shared/utils/prisma/enums';

type Props = IconProps & {
  currency?: Currency;
} & { currency?: 'BUZZ'; type?: BuzzSpendType };

export function CurrencyIcon({ currency = Currency.BUZZ, type, ...iconProps }: Props) {
  const config = getCurrencyConfig({ currency, type });
  const Icon = config.icon;

  // TODO: Add tooltip: this action will cost <CURRENCY>

  return <Icon color={config.color} fill={config.fill ?? 'transparent'} {...iconProps} />;
}
