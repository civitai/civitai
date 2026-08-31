import type { IconProps, Icon } from '@tabler/icons-react';
import { IconBolt, IconCurrencyDollar } from '@tabler/icons-react';
import type { ForwardRefExoticComponent } from 'react';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { CurrencyThemeColors } from '~/shared/constants/currency-theme.constants';
import { CurrencyThemeConfig } from '~/shared/constants/currency-theme.constants';
import { Currency } from '~/shared/utils/prisma/enums';

type CurrencyTheme = CurrencyThemeColors & {
  icon: ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>;
};

type CurrencyConfig = {
  USD: CurrencyTheme;
  USDC: CurrencyTheme;
  BUZZ: CurrencyTheme & { themes: Record<BuzzSpendType, CurrencyTheme> };
};

const withIcon = <T extends CurrencyThemeColors>(theme: T, icon: CurrencyTheme['icon']) => ({
  ...theme,
  icon,
});

export const CurrencyConfig: CurrencyConfig = {
  [Currency.BUZZ]: {
    ...withIcon(CurrencyThemeConfig.BUZZ, IconBolt),
    themes: Object.fromEntries(
      Object.entries(CurrencyThemeConfig.BUZZ.themes).map(([type, theme]) => [
        type,
        withIcon(theme, IconBolt),
      ])
    ) as Record<BuzzSpendType, CurrencyTheme>,
  },
  [Currency.USD]: withIcon(CurrencyThemeConfig.USD, IconCurrencyDollar),
  [Currency.USDC]: withIcon(CurrencyThemeConfig.USDC, IconCurrencyDollar),
};

export function getBuzzCurrencyConfig(type: BuzzSpendType = 'yellow') {
  // Callers reach this with `CustomerSubscription.buzzType`, which is a subscription-KIND
  // discriminator for some rows ('buzzPurchase', 'referral') rather than a currency. Those
  // have no theme, and returning undefined crashed every consumer on `config.icon`.
  return CurrencyConfig.BUZZ.themes[type] ?? CurrencyConfig.BUZZ.themes.yellow;
}

export function getCurrencyConfig(
  args: { currency: 'USD' | 'USDC' } | { currency: 'BUZZ'; type?: BuzzSpendType }
) {
  if (args.currency === Currency.BUZZ) return CurrencyConfig.BUZZ.themes[args.type ?? 'yellow'];
  else return CurrencyConfig[args.currency];
}
