import { useMantineTheme, rgba } from '@mantine/core';
import { CurrencyConfig } from '~/server/common/constants';
import type { BuzzAccountType } from '~/server/schema/buzz.schema';
import { Currency } from '~/shared/utils/prisma/enums';
import { hexToRgbOpenEnded } from '~/utils/mantine-css-helpers';

export function useCurrencyConfig(currency?: Currency, type?: string) {
  currency = currency ?? Currency.BUZZ; // Default to USD if no currency is provided
  const config = CurrencyConfig[currency].themes?.[type ?? ''] ?? CurrencyConfig[currency];
  return config;
}

export function useBuzzCurrencyConfig(type?: BuzzAccountType | 'red' | undefined) {
  const config = useCurrencyConfig(Currency.BUZZ, type);

  return {
    icon: config.icon,
    color: config.color,
    colorRgb: hexToRgbOpenEnded(config.color),
    fill: config.fill ? config.fill : undefined,
    classNames: config.classNames,
    css: config.css,
  };
}
