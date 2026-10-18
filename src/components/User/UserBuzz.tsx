import type { MantineSize, TextProps } from '@mantine/core';
import { Group, Loader, Text, Tooltip } from '@mantine/core';
import { BuzzDeltaPop } from '~/components/Buzz/BuzzDeltaPop';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { CustomNumberFlow } from '~/components/Metrics/CustomNumberFlow';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import {
  createBuzzDistributionGradient,
  createBuzzDistributionLabel,
  getBuzzTypeDistribution,
} from '~/utils/buzz';
import { abbreviateNumber } from '~/utils/number-helpers';
import classes from './UserBuzz.module.scss';
import clsx from 'clsx';
import { BuzzBoltSvg } from '~/components/User/BuzzBoltSvg';
import { Currency } from '~/shared/utils/prisma/enums';
import { getCurrencyConfig } from '~/shared/constants/currency.constants';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';

type Props = TextProps & {
  iconSize?: number;
  textSize?: MantineSize;
  withTooltip?: boolean;
  withAbbreviation?: boolean;
  /** Roll the digits when the balance changes. */
  animated?: boolean;
  /** Show the "-N" that rolls out of the counter. Renders inside a positioned wrapper. */
  withDeltaPop?: boolean;
  accountId?: number;
  accountTypes?: BuzzSpendType[];
  theme?: string;
};

export function UserBuzz({
  iconSize = 20,
  textSize = 'md',
  withTooltip,
  withAbbreviation = true,
  animated = false,
  withDeltaPop = false,
  accountId,
  accountTypes,
  ...textProps
}: Props) {
  const availableTypes = useAvailableBuzz(['blue']);
  accountTypes ??= availableTypes;
  const {
    data: { accounts, total },
    isLoading,
  } = useQueryBuzz(accountTypes);

  const balance = total;
  const baseAccountType = accounts[0]?.type;
  const config = getCurrencyConfig({ currency: Currency.BUZZ, type: baseAccountType });
  const Icon = config.icon;
  const typeDistribution = getBuzzTypeDistribution({
    accounts,
    buzzAmount: balance,
  });
  const gradient = createBuzzDistributionGradient({
    typeDistribution,
    direction: 'bottom',
  });
  const label = createBuzzDistributionLabel({
    typeDistribution,
  });

  const content = isLoading ? (
    <Group gap={4} wrap="nowrap">
      <Icon size={iconSize} color={config.color} fill={config.color} />
      <Loader color={config.color} type="dots" size="xs" />
    </Group>
  ) : (
    <Text
      component="div"
      c={config.color}
      tt="uppercase"
      style={{
        '--buzz-gradient': gradient || config.color,
        ...textProps.style,
      }}
      className={clsx(classes.userBuzz, gradient && classes.withGradient, textProps.className)}
      {...textProps}
    >
      <Group gap={4} wrap="nowrap">
        <BuzzBoltSvg
          size={iconSize}
          color={gradient ? undefined : config.color}
          fill={gradient ? undefined : config.color}
          gradient={gradient}
        />
        <Text
          size={textSize}
          fw={600}
          lh={0}
          className={clsx(classes.buzzText, gradient && classes.withGradient)}
          span
        >
          {balance === null ? (
            <Loader
              size="sm"
              type="dots"
              color={gradient ? undefined : config.color}
              className={clsx(classes.buzzLoader, gradient && classes.withGradient)}
            />
          ) : animated ? (
            <AnimatedBalance
              balance={balance}
              abbreviate={withAbbreviation}
              gradient={!!gradient}
            />
          ) : withAbbreviation ? (
            abbreviateNumber(balance, { floor: true, decimals: 1 })
          ) : (
            balance.toLocaleString()
          )}
        </Text>
      </Group>
    </Text>
  );

  const counter = withTooltip ? <Tooltip label={label}>{content}</Tooltip> : content;
  if (!withDeltaPop) return counter;

  return (
    <div className="relative">
      {counter}
      <BuzzDeltaPop accountTypes={accountTypes} />
    </div>
  );
}

function AnimatedBalance({
  balance,
  abbreviate,
  gradient,
}: {
  balance: number;
  abbreviate: boolean;
  gradient: boolean;
}) {
  if (!abbreviate) return <CustomNumberFlow value={balance} gradient={gradient} />;

  // Floored like `abbreviateNumber`, which `NumberFlow`'s own compact notation would round instead.
  const text = abbreviateNumber(balance, { floor: true, decimals: 1 });
  const match = /^(-?\d+(?:\.\d+)?)([kmbt]?)$/.exec(text);
  if (!match) return <>{text}</>;

  return (
    <span className="inline-flex items-baseline leading-none">
      <CustomNumberFlow value={Number(match[1])} gradient={gradient} />
      {match[2]}
    </span>
  );
}
