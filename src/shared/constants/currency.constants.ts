import type { MantineTheme } from '@mantine/core';
import type { IconProps, Icon } from '@tabler/icons-react';
import { IconBolt, IconCurrencyDollar } from '@tabler/icons-react';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import { Currency } from '~/shared/utils/prisma/enums';

type CurrencyTheme = {
  icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  color: (theme: MantineTheme) => string;
  fill?: (theme: MantineTheme) => string | undefined;
};

export const CurrencyConfig: Record<
  Currency,
  CurrencyTheme & { themes?: Record<string, CurrencyTheme> }
> = {
  [Currency.BUZZ]: {
    icon: IconBolt,
    color: (theme) => theme.colors.yellow[7],
    fill: (theme) => theme.colors.yellow[7],
    themes: {
      generation: {
        icon: IconBolt,
        color: (theme) => theme.colors.blue[4],
        fill: (theme) => theme.colors.blue[4],
      },
    },
  },
  [Currency.USD]: {
    icon: IconCurrencyDollar,
    color: (theme) => theme.colors.yellow[7],
    fill: undefined,
  },
  [Currency.USDC]: {
    icon: IconCurrencyDollar,
    color: (theme) => theme.colors.yellow[7],
    fill: undefined,
  },
};
