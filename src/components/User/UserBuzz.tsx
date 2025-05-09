import {
  Group,
  Loader,
  MantineSize,
  Text,
  TextProps,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { abbreviateNumber } from '~/utils/number-helpers';
import type { BuzzAccountType } from '~/server/schema/buzz.schema';
import { CurrencyConfig } from '~/server/common/constants';

type Props = TextProps & {
  iconSize?: number;
  textSize?: MantineSize;
  withTooltip?: boolean;
  withAbbreviation?: boolean;
  accountId?: number;
  accountType?: BuzzAccountType | null;
  theme?: string;
};

export function UserBuzz({
  iconSize = 20,
  textSize = 'md',
  withTooltip,
  withAbbreviation = true,
  accountId,
  accountType,
  ...textProps
}: Props) {
  const { balance, balanceLoading } = useBuzz(accountId, accountType);
  const config = CurrencyConfig.BUZZ.themes?.[accountType ?? ''] ?? CurrencyConfig.BUZZ;
  const Icon = config.icon;
  const theme = useMantineTheme();

  const content = balanceLoading ? (
    <Group gap={4} wrap="nowrap">
      <Icon size={iconSize} color={config.color(theme)} fill={config.color(theme)} />
      <Loader color={config.color(theme)} variant="dots" size="xs" />
    </Group>
  ) : (
    <Text color={config.color(theme)} transform="uppercase" {...textProps}>
      <Group gap={4} wrap="nowrap">
        <Icon size={iconSize} color="currentColor" fill="currentColor" />
        <Text size={textSize} weight={600} lh={0} sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {balance === null ? (
            <Loader size="sm" variant="dots" color={config.color(theme)} />
          ) : withAbbreviation ? (
            abbreviateNumber(balance, { floor: true })
          ) : (
            balance.toLocaleString()
          )}
        </Text>
      </Group>
    </Text>
  );

  return withTooltip ? (
    <Tooltip
      label={`Total balance: ${balance === null ? '(Loading...)' : balance.toLocaleString()}`}
    >
      {content}
    </Tooltip>
  ) : (
    content
  );
}
