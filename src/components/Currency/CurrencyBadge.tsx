import { Badge, BadgeProps, Group, Loader, MantineSize, useMantineTheme } from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconProps } from '@tabler/icons-react';
import { CurrencyConfig } from '~/server/common/constants';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';

type Props = BadgeProps & {
  currency: Currency;
  unitAmount: number;
  formatter?: (value: number) => string;
  displayCurrency?: boolean;
  loading?: boolean;
  iconProps?: IconProps;
  textColor?: string;
  innerRef?: React.ForwardedRef<HTMLDivElement>;
  typeDistrib?: { bluePct: number; yellowPct: number };
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
  typeDistrib,
  ...badgeProps
}: Props) {
  const value = formatCurrencyForDisplay(unitAmount, currency);
  const theme = useMantineTheme();
  const Icon = CurrencyConfig[currency].icon;
  const config = CurrencyConfig[currency];
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
        position: 'relative',
        ...(sx ? (typeof sx === 'function' ? sx(theme) : sx) : {}),
      }}
      styles={{
        root: typeDistrib
          ? {
              '::after': {
                content: '""',
                position: 'absolute',
                left: '1px',
                right: '1px',
                top: '1px',
                bottom: '1px',
                border: '2px solid red',
                pointerEvents: 'none',
                borderRadius: '50%',
                borderImage: `linear-gradient(to right, ${theme.colors.blue[4]} ${Math.round(
                  typeDistrib.bluePct * 100
                )}%, ${theme.colors.yellow[7]} ${Math.round(typeDistrib.bluePct * 100)}%, ${
                  theme.colors.yellow[7]
                } ${Math.round(typeDistrib.yellowPct * 100)}%) 1`,
                clipPath: 'inset(0% 0% 0% 0% round 2px)',
              },
            }
          : undefined,
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
