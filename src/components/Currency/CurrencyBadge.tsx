import { Badge, BadgeProps, Loader, MantineSize, Tooltip, useMantineTheme } from '@mantine/core';
import { Currency } from '~/shared/utils/prisma/enums';
import { IconProps } from '@tabler/icons-react';
import { BuzzTypeDistribution } from '~/components/Buzz/buzz.utils';
import { CurrencyConfig } from '~/server/common/constants';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { forwardRef } from 'react';

type Props = BadgeProps & {
  currency: Currency;
  unitAmount: number;
  formatter?: (value: number) => string;
  displayCurrency?: boolean;
  loading?: boolean;
  iconProps?: IconProps;
  textColor?: string;
  type?: string;
  typeDistrib?: BuzzTypeDistribution;
};

const iconSize: Record<MantineSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
};

export const CurrencyBadge = forwardRef<HTMLDivElement, Props>(
  (
    {
      unitAmount,
      currency,
      formatter,
      displayCurrency = true,
      sx,
      children,
      loading,
      iconProps,
      textColor,
      type,
      typeDistrib,
      ...badgeProps
    },
    ref
  ) => {
    const value = formatCurrencyForDisplay(unitAmount, currency);
    const theme = useMantineTheme();
    const config = CurrencyConfig[currency].themes?.[type ?? ''] ?? CurrencyConfig[currency];
    const Icon = config.icon;
    const colorString = textColor || config.color(theme);

    return (
      <Tooltip
        label={
          typeDistrib
            ? `Blue: ${typeDistrib.amt.blue} | Yellow: ${typeDistrib.amt.yellow}`
            : undefined
        }
        disabled={!typeDistrib}
      >
        <Badge
          ref={ref}
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
                    pointerEvents: 'none',
                    left: '1px',
                    right: '1px',
                    top: '1px',
                    bottom: '1px',
                    border: '1px solid yellow',
                    borderRadius: '50%',
                    borderImage: `linear-gradient(to right, ${theme.colors.blue[4]} ${Math.round(
                      typeDistrib.pct.blue * 100
                    )}%, ${theme.colors.yellow[7]} ${Math.round(typeDistrib.pct.blue * 100)}%, ${
                      theme.colors.yellow[7]
                    } ${Math.round(typeDistrib.pct.yellow * 100)}%) 1`,
                    clipPath: 'inset(0% 0% 0% 0% round 1px)',
                  },
                }
              : undefined,
          }}
          {...badgeProps}
        >
          <div className="flex items-center gap-1">
            <Icon
              size={iconSize[badgeProps.size ?? 'sm']}
              fill={currency === Currency.BUZZ ? 'currentColor' : undefined}
              {...iconProps}
            />
            {loading ? (
              <Loader size="xs" variant="dots" color={colorString} />
            ) : (
              <div className="flex items-center gap-1">
                {formatter
                  ? formatter(unitAmount)
                  : `${value || 0} ${displayCurrency ? currency : ''}`}
                {children}
              </div>
            )}
          </div>
        </Badge>
      </Tooltip>
    );
  }
);
CurrencyBadge.displayName = 'CurrencyBadge';
