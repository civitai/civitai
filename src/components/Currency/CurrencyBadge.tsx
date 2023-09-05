import {
  Badge,
  BadgeProps,
  Button,
  ButtonProps,
  Group,
  MantineTheme,
  useMantineTheme,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconBolt, IconCurrencyDollar, TablerIconsProps } from '@tabler/icons-react';
import { formatCurrencyForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { CurrencyConfig } from '~/server/common/constants';

type Props = BadgeProps & {
  currency: Currency;
  unitAmount: number;
  formatter?: (value: number) => string;
  displayCurrency?: boolean;
};

export function CurrencyBadge({
  unitAmount,
  currency,
  formatter,
  displayCurrency = true,
  ...badgeProps
}: Props) {
  const value = formatCurrencyForDisplay(unitAmount, currency);
  const theme = useMantineTheme();
  const Icon = CurrencyConfig[currency].icon;
  const config = CurrencyConfig[currency];

  return (
    <Badge
      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      color="gray"
      radius="xl"
      pl={8}
      pr={12}
      sx={{
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.5,
        color: config.color ? config.color(theme) : theme.colors.accent[5],
      }}
      {...badgeProps}
    >
      <Group spacing={4} noWrap>
        <Icon size={14} fill="currentColor" />
        {formatter ? (
          formatter(unitAmount)
        ) : (
          <>
            {value} {displayCurrency ? currency : ''}
          </>
        )}
      </Group>
    </Badge>
  );
}
