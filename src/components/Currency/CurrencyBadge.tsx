import {
  Badge,
  BadgeProps,
  Loader,
  MantineSize,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import NumberFlow from '@number-flow/react';
import { IconProps } from '@tabler/icons-react';
import React, { forwardRef } from 'react';
import { BuzzTypeDistribution } from '~/components/Buzz/buzz.utils';
import { CurrencyConfig } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import classes from './CurrencyBadge.module.scss';
import clsx from 'clsx';
import { label } from 'motion/dist/react-m';

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
  asCounter?: boolean;
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
      children,
      loading,
      iconProps,
      textColor,
      type,
      typeDistrib,
      asCounter,
      style,
      className,
      ...badgeProps
    },
    ref
  ) => {
    const value = formatCurrencyForDisplay(unitAmount, currency);
    const theme = useMantineTheme();
    const colorScheme = useComputedColorScheme('dark');
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
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          color="gray"
          radius="xl"
          pl={8}
          pr={12}
          style={{
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.5,
            color: colorString,
            position: 'relative',
            ...(style ?? {}),
            '--border-image': typeDistrib
              ? `linear-gradient(to right, ${theme.colors.blue[4]} ${Math.round(
                  typeDistrib.pct.blue * 100
                )}%, ${theme.colors.yellow[7]} ${Math.round(typeDistrib.pct.blue * 100)}%, ${
                  theme.colors.yellow[7]
                } ${Math.round(typeDistrib.pct.yellow * 100)}%) 1`
              : undefined,
          }}
          classNames={{
            root: clsx(typeDistrib && classes.badgeWithDistrib, className),
            label: 'flex gap-0.5 items-center flex-nowrap',
          }}
          {...badgeProps}
        >
          <div className="flex items-center gap-1">
            <Icon
              size={iconSize[(badgeProps.size as MantineSize) ?? 'sm']}
              fill={currency === Currency.BUZZ ? 'currentColor' : undefined}
              {...iconProps}
            />
            {loading ? (
              <Loader size="xs" type="dots" color={colorString} />
            ) : (
              <div className="flex items-center gap-1">
                {asCounter ? (
                  <NumberFlow respectMotionPreference={false} value={unitAmount} />
                ) : (
                  <Text fw={600} size="xs">
                    {formatter
                      ? formatter(unitAmount)
                      : `${value || 0} ${displayCurrency ? currency : ''}`}
                  </Text>
                )}
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
