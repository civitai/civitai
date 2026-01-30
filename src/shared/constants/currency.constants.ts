import type { IconProps, Icon } from '@tabler/icons-react';
import { IconBolt, IconCurrencyDollar } from '@tabler/icons-react';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { Currency } from '~/shared/utils/prisma/enums';

type CurrencyTheme = {
  icon: ForwardRefExoticComponent<IconProps & React.RefAttributes<SVGSVGElement>>;
  color: string;
  fill?: string | undefined;
  cssVariableName?: string;
  css?: {
    gradient?: string;
  };
  classNames?: {
    btn?: string;
    gradient?: string;
    gradientText?: string;
  };
};

type CurrencyConfig = {
  USD: CurrencyTheme;
  USDC: CurrencyTheme;
  BUZZ: CurrencyTheme & { themes: Record<BuzzSpendType, CurrencyTheme> };
};

export const CurrencyConfig: CurrencyConfig = {
  [Currency.BUZZ]: {
    icon: IconBolt,
    color: '#f59f00',
    fill: '#f59f00',
    css: {
      gradient:
        'linear-gradient(135deg, var(--mantine-color-yellow-4) 0%, var(--mantine-color-orange-5) 100%)',
    },
    classNames: {
      btn: 'bg-gradient-to-r from-orange-500 to-yellow-400 hover:from-orange-600 hover:to-yellow-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 shadow min-w-[140px] font-bold transition-all duration-150 border-none text-white',
      gradient: 'bg-gradient-to-r from-orange-500 to-yellow-400',
      gradientText: 'bg-gradient-to-r from-orange-500 to-yellow-400 bg-clip-text text-transparent',
    },
    themes: {
      blue: {
        icon: IconBolt,
        color: '#4dabf7',
        fill: '#4dabf7',
        classNames: {
          btn: 'bg-gradient-to-r from-blue-500 to-cyan-400 hover:from-blue-600 hover:to-cyan-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 shadow min-w-[140px] font-bold transition-all duration-150 border-none text-white',
          gradient: 'bg-gradient-to-r from-blue-500 to-cyan-400',
          gradientText: 'bg-gradient-to-r from-blue-500 to-cyan-400 bg-clip-text text-transparent',
        },
        css: {
          gradient:
            'linear-gradient(135deg, var(--mantine-color-cyan-4) 0%, var(--mantine-color-blue-5) 100%)',
        },
      },
      green: {
        icon: IconBolt,
        color: '#40c057',
        fill: '#40c057',
        classNames: {
          btn: 'bg-gradient-to-r from-green-500 to-emerald-400 hover:from-green-600 hover:to-emerald-500 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 shadow min-w-[140px] font-bold transition-all duration-150 border-none text-white',
          gradient: 'bg-gradient-to-r from-green-500 to-emerald-400',
          gradientText:
            'bg-gradient-to-r from-green-500 to-emerald-400 bg-clip-text text-transparent',
        },
        css: {
          gradient:
            'linear-gradient(135deg, var(--mantine-color-lime-4) 0%, var(--mantine-color-green-6) 100%)',
        },
      },
      yellow: {
        icon: IconBolt,
        color: '#f59f00',
        fill: '#f59f00',
        css: {
          gradient:
            'linear-gradient(135deg, var(--mantine-color-yellow-4) 0%, var(--mantine-color-orange-5) 100%)',
        },
        classNames: {
          btn: 'bg-gradient-to-r from-orange-500 to-yellow-400 hover:from-orange-600 hover:to-yellow-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 shadow min-w-[140px] font-bold transition-all duration-150 border-none text-white',
          gradient: 'bg-gradient-to-r from-orange-500 to-yellow-400',
          gradientText:
            'bg-gradient-to-r from-orange-500 to-yellow-400 bg-clip-text text-transparent',
        },
      },
      red: {
        icon: IconBolt,
        color: '#f03e3e',
        fill: '#f03e3e',
        classNames: {
          btn: 'bg-gradient-to-r from-rose-500 to-pink-400 hover:from-rose-600 hover:to-pink-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 shadow min-w-[140px] font-bold transition-all duration-150 border-none text-white dark:border-rose-600',
          gradient: 'bg-gradient-to-r from-rose-500 to-pink-400',
          gradientText: 'bg-gradient-to-r from-rose-500 to-pink-400 bg-clip-text text-transparent',
        },
        css: {
          gradient:
            'linear-gradient(135deg, var(--mantine-color-red-5) 0%, var(--mantine-color-pink-6) 100%)',
        },
      },
    },
  },
  [Currency.USD]: {
    icon: IconCurrencyDollar,
    color: '#f59f00',
    fill: undefined,
  },
  [Currency.USDC]: {
    icon: IconCurrencyDollar,
    color: '#f59f00',
    fill: undefined,
  },
};

export function getBuzzCurrencyConfig(type: BuzzSpendType = 'yellow') {
  return CurrencyConfig.BUZZ.themes[type];
}

export function getCurrencyConfig(
  args: { currency: 'USD' | 'USDC' } | { currency: 'BUZZ'; type?: BuzzSpendType }
) {
  if (args.currency === Currency.BUZZ) return CurrencyConfig.BUZZ.themes[args.type ?? 'yellow'];
  else return CurrencyConfig[args.currency];
}
