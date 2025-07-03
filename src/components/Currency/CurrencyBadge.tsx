import type { BadgeProps, MantineSize } from '@mantine/core';
import { Badge, Loader, Text, Tooltip, useComputedColorScheme } from '@mantine/core';
import NumberFlow from '@number-flow/react';
import type { IconProps } from '@tabler/icons-react';
import React, { forwardRef } from 'react';
import type { BuzzTypeDistribution } from '~/components/Buzz/buzz.utils';
import { CurrencyConfig } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import classes from './CurrencyBadge.module.scss';
import clsx from 'clsx';
import type { BuzzAccountType } from '~/server/schema/buzz.schema';

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
    const colorScheme = useComputedColorScheme('dark');
    const config = CurrencyConfig[currency].themes?.[type ?? ''] ?? CurrencyConfig[currency];
    const Icon = config.icon;
    const colorString = textColor || config.color;

    // Create tooltip label for distribution
    const createDistributionLabel = () => {
      if (!typeDistrib) return undefined;

      const entries = Object.entries(typeDistrib.amt).filter(([, amount]) => (amount || 0) > 0);
      return entries
        .map(([accountType, amount]) => {
          const typeName =
            accountType === 'generation'
              ? 'Blue'
              : accountType === 'green'
              ? 'Green'
              : accountType === 'user'
              ? 'Yellow'
              : accountType.charAt(0).toUpperCase() + accountType.slice(1);
          return `${typeName}: ${amount || 0}`;
        })
        .join(' | ');
    };

    // Create gradient from distribution
    const createDistributionGradient = () => {
      if (!typeDistrib || loading) return undefined;

      const entries = Object.entries(typeDistrib.pct).filter(([, pct]) => (pct || 0) > 0);
      if (entries.length <= 1) return undefined;

      let currentPct = 0;
      const gradientStops = entries.map(([accountType, pct]) => {
        const typeConfig =
          CurrencyConfig[currency].themes?.[accountType as BuzzAccountType] ??
          CurrencyConfig[currency];
        const startPct = currentPct;
        currentPct += (pct || 0) * 100;
        return `${typeConfig.color} ${startPct}%, ${typeConfig.color} ${currentPct}%`;
      });

      return `linear-gradient(to right, ${gradientStops.join(', ')}) 1`;
    };

    const gradient = createDistributionGradient();

    return (
      <Tooltip label={createDistributionLabel()} disabled={!typeDistrib}>
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
            '--border-image': gradient,
          }}
          classNames={{
            root: clsx(!loading && typeDistrib && gradient && classes.badgeWithDistrib, className),
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
