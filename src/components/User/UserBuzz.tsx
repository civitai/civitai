import { Group, Loader, MantineSize, Text, TextProps, Tooltip } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { abbreviateNumber } from '~/utils/number-helpers';
import { BuzzAccountType } from '~/server/schema/buzz.schema';

type Props = TextProps & {
  iconSize?: number;
  textSize?: MantineSize;
  withTooltip?: boolean;
  withAbbreviation?: boolean;
  accountId?: number;
  accountType?: BuzzAccountType;
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
  const { balance } = useBuzz(accountId, accountType);

  const content = (
    <Text color="accent.5" transform="uppercase" {...textProps}>
      <Group spacing={4} noWrap>
        <IconBolt size={iconSize} color="currentColor" fill="currentColor" />
        <Text size={textSize} weight={600} lh={0} sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {balance === null ? (
            <Loader size="sm" variant="dots" color="accent.5" />
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
