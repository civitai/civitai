import { getBuzzCurrencyConfig } from '~/server/common/constants';
import type { BuzzSpendType } from '~/server/schema/buzz.schema';
import { Currency } from '~/shared/utils/prisma/enums';
import { hexToRgbOpenEnded } from '~/utils/mantine-css-helpers';

// export function useCurrencyConfig(currency?: Currency, type?: string) {
//   currency = currency ?? Currency.BUZZ; // Default to USD if no currency is provided
//   const config = CurrencyConfig[currency].themes?.[type ?? ''] ?? CurrencyConfig[currency];
//   return config;
// }

export function useBuzzCurrencyConfig(type: BuzzSpendType = 'yellow') {
  const config = getBuzzCurrencyConfig(type);

  return {
    icon: config.icon,
    color: config.color,
    colorRgb: hexToRgbOpenEnded(config.color),
    fill: config.fill ? config.fill : undefined,
    classNames: config.classNames,
    css: config.css,
  };
}
