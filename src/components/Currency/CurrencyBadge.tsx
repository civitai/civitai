import {
  Badge,
  BadgeProps,
  Button,
  ButtonProps,
  Group,
  Loader,
  MantineSize,
  MantineTheme,
  useMantineTheme,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconBolt, IconCurrencyDollar, IconProps } from '@tabler/icons-react';
import { formatCurrencyForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { CurrencyConfig } from '~/server/common/constants';

type Props = BadgeProps & {
  currency: Currency;
  unitAmount: number;
  formatter?: (value: number) => string;
  displayCurrency?: boolean;
  loading?: boolean;
};

const iconSize: Record<MantineSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
};

export function CurrencyBadge({
  unitAmount,
  currency,
  formatter,
  displayCurrency = true,
  sx,
  children,
  loading,
  ...badgeProps
}: Props) {
  const value = formatCurrencyForDisplay(unitAmount, currency);
  const theme = useMantineTheme();
  const Icon = CurrencyConfig[currency].icon;
  const config = CurrencyConfig[currency];
  const colorString = config.color(theme);

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
        ...(sx ? (typeof sx === 'function' ? sx(theme) : sx) : {}),
      }}
      {...badgeProps}
    >
      <Group spacing={4} noWrap>
        <Icon size={iconSize[badgeProps.size ?? 'sm']} fill="currentColor" />
        {loading && <Loader size="xs" variant="dots" color={colorString} />}
        {!loading && (
          <>
            {formatter ? (
              formatter(unitAmount)
            ) : (
              <>
                {value || 0} {displayCurrency ? currency : ''}
              </>
            )}
            {children}
          </>
        )}
      </Group>
    </Badge>
  );
}
