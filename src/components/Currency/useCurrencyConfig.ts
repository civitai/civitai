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

  // Define CSS gradients based on buzz type using Mantine color variables
  const getCssGradient = () => {
    switch (type) {
      case 'green':
        return 'linear-gradient(135deg, var(--mantine-color-lime-4) 0%, var(--mantine-color-green-6) 100%)';
      case 'red':
      case 'fakered':
        return 'linear-gradient(135deg, var(--mantine-color-pink-4) 0%, var(--mantine-color-rose-5) 100%)';
      case 'generation':
        return 'linear-gradient(135deg, var(--mantine-color-cyan-4) 0%, var(--mantine-color-blue-5) 100%)';
      default:
        return 'linear-gradient(135deg, var(--mantine-color-yellow-4) 0%, var(--mantine-color-orange-5) 100%)';
    }
  };

  return {
    icon: config.icon,
    color: config.color,
    colorRgb: hexToRgbOpenEnded(config.color),
    fill: config.fill ? config.fill : undefined,
    classNames: config.classNames,
    cssGradient: getCssGradient(),
  };
}
