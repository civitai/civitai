import type { IconProps } from '@tabler/icons-react';
import React from 'react';
import { getCurrencyConfig } from '~/server/common/constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { Currency } from '~/shared/utils/prisma/enums';

type Props = IconProps &
  ({ currency: 'USD' | 'USDC' } | { currency: 'BUZZ'; type?: BuzzSpendType });

export function CurrencyIcon(props: Props) {
  const { currency, type, ...iconProps } = props;
  const config = getCurrencyConfig(props);
  const Icon = config.icon;

  // TODO: Add tooltip: this action will cost <CURRENCY>

  return <Icon color={config.color} fill={config.fill ?? 'transparent'} {...iconProps} />;
}
