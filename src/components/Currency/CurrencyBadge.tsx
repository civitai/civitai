import type { BadgeProps, MantineSize } from '@mantine/core';
import { Badge, Loader, Text, Tooltip, useComputedColorScheme } from '@mantine/core';
import NumberFlow from '@number-flow/react';
import type { IconProps } from '@tabler/icons-react';
import React, { forwardRef } from 'react';
import { getCurrencyConfig } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import classes from './CurrencyBadge.module.scss';
import clsx from 'clsx';
import type { BuzzTypeDistribution } from '~/utils/buzz';
import { createBuzzDistributionGradient, createBuzzDistributionLabel } from '~/utils/buzz';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

type Props = BadgeProps & {
  // currency: Currency;
  unitAmount: number;
  formatter?: (value: number) => string;
  displayCurrency?: boolean;
  loading?: boolean;
  iconProps?: IconProps;
  textColor?: string;
  type?: string;
  typeDistribution?: BuzzTypeDistribution;
  asCounter?: boolean;
} & ({ currency: 'BUZZ'; type?: BuzzSpendType } | { currency: 'USD' | 'USDC' });

const iconSize: Record<MantineSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
};

export const CurrencyBadge = forwardRef<HTMLDivElement, Props>((props, ref) => {
  const {
    unitAmount,
    currency,
    formatter,
    displayCurrency = true,
    children,
    loading,
    iconProps,
    textColor,
    type,
    typeDistribution,
    asCounter,
    style,
    className,
    ...badgeProps
  } = props;
  const value = formatCurrencyForDisplay(unitAmount, currency);
  const colorScheme = useComputedColorScheme('dark');
  const config = getCurrencyConfig(props);
  const Icon = config.icon;
  const colorString = textColor || config.color;

  const label = createBuzzDistributionLabel({
    typeDistribution,
  });

  const gradient = createBuzzDistributionGradient({
    typeDistribution,
  });

  return (
    <Tooltip label={label} disabled={!typeDistribution}>
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
          root: clsx(
            !loading && typeDistribution && gradient && classes.badgeWithDistrib,
            className
          ),
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
});
CurrencyBadge.displayName = 'CurrencyBadge';
