import { Group, Loader, MantineSize, Text, TextProps, Tooltip } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { CivitaiSessionState } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { abbreviateNumber } from '~/utils/number-helpers';

type Props = TextProps & {
  user: CivitaiSessionState | null;
  iconSize?: number;
  textSize?: MantineSize;
  withTooltip?: boolean;
  withAbbreviation?: boolean;
};

export function UserBuzz({
  user,
  iconSize = 20,
  textSize = 'md',
  withTooltip,
  withAbbreviation = true,
  ...textProps
}: Props) {
  if (!user) return null;
  const { balance } = user;

  const content = (
    <Text color="accent.5" transform="uppercase" {...textProps}>
      <Group spacing={4} noWrap>
        <IconBolt size={iconSize} color="currentColor" fill="currentColor" />
        <Text size={textSize} weight={600} lh={0} sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {balance === null ? (
            <Loader size="sm" variant="dots" color="accent.5" />
          ) : withAbbreviation ? (
            abbreviateNumber(balance)
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
