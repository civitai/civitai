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
  iconProps?: IconProps;
  textColor?: string;
  innerRef?: React.ForwardedRef<HTMLDivElement>;
  type?: string;
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
  iconProps,
  textColor,
  innerRef,
  type,
  ...badgeProps
}: Props) {
  const value = formatCurrencyForDisplay(unitAmount, currency);
  const theme = useMantineTheme();
  const config = CurrencyConfig[currency].themes?.[type ?? ''] ?? CurrencyConfig[currency];
  const Icon = config.icon;
  const colorString = textColor || config.color(theme);

  return (
    <Badge
      ref={innerRef}
      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      color="gray"
      radius="xl"
      pl={8}
      pr={12}
      sx={{
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.5,
        color: colorString,
        ...(sx ? (typeof sx === 'function' ? sx(theme) : sx) : {}),
      }}
      {...badgeProps}
    >
      <Group spacing={4} noWrap>
        <Icon
          size={iconSize[badgeProps.size ?? 'sm']}
          fill={currency === Currency.BUZZ ? 'currentColor' : undefined}
          {...iconProps}
        />
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
