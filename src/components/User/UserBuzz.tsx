import type { MantineSize, TextProps } from '@mantine/core';
import { Group, Loader, Text, Tooltip } from '@mantine/core';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { getCurrencyConfig } from '~/server/common/constants';
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

type Props = TextProps & {
  iconSize?: number;
  textSize?: MantineSize;
  withTooltip?: boolean;
  withAbbreviation?: boolean;
  accountId?: number;
  accountTypes?: BuzzSpendType[];
  theme?: string;
};

export function UserBuzz({
  iconSize = 20,
  textSize = 'md',
  withTooltip,
  withAbbreviation = true,
  accountId,
  accountTypes = buzzSpendTypes,
  ...textProps
}: Props) {
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
