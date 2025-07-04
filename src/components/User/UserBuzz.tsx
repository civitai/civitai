import type { MantineSize, TextProps } from '@mantine/core';
import { Group, Loader, Text, Tooltip } from '@mantine/core';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyConfig } from '~/server/common/constants';
import type { BuzzAccountType } from '~/server/schema/buzz.schema';
import {
  createBuzzDistributionGradient,
  createBuzzDistributionLabel,
  getBuzzTypeDistribution,
} from '~/utils/buzz';
import { abbreviateNumber } from '~/utils/number-helpers';
import classes from './UserBuzz.module.scss';
import clsx from 'clsx';
import { BuzzBoltSvg } from '~/components/User/BuzzBoltSvg';

type Props = TextProps & {
  iconSize?: number;
  textSize?: MantineSize;
  withTooltip?: boolean;
  withAbbreviation?: boolean;
  accountId?: number;
  accountTypes?: BuzzAccountType[] | null;
  theme?: string;
};

export function UserBuzz({
  iconSize = 20,
  textSize = 'md',
  withTooltip,
  withAbbreviation = true,
  accountId,
  accountTypes,
  ...textProps
}: Props) {
  const { balances, balanceLoading } = useBuzz(accountId, accountTypes);
  const balance = (balances ?? []).reduce((acc, curr) => acc + (curr.balance ?? 0), 0);
  const [baseAccountType] = accountTypes ?? ['user'];
  const config = CurrencyConfig.BUZZ.themes?.[baseAccountType ?? ''] ?? CurrencyConfig.BUZZ;
  const Icon = config.icon;
  const typeDistribution = getBuzzTypeDistribution({
    balances: balances ?? [],
    accountTypes: accountTypes ?? ['user'],
    buzzAmount: balance,
  });
  const gradient = createBuzzDistributionGradient({
    typeDistribution,
    direction: 'bottom',
  });
  const label = createBuzzDistributionLabel({
    typeDistribution,
  });

  const content = balanceLoading ? (
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
          className={clsx(classes.buzzIcon, gradient && classes.withGradient)}
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
          ) : withAbbreviation ? (
            abbreviateNumber(balance, { floor: true })
          ) : (
            balance.toLocaleString()
          )}
        </Text>
      </Group>
    </Text>
  );

  return withTooltip ? <Tooltip label={label}>{content}</Tooltip> : content;
}
