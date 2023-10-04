import { Group, MantineSize, Text, TextProps, Tooltip } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { CivitaiSessionState } from '~/components/CivitaiWrapped/CivitaiSessionProvider';

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

  const content = (
    <Text color="accent.5" transform="uppercase" {...textProps}>
      <Group spacing={4} noWrap>
        <IconBolt size={iconSize} color="currentColor" fill="currentColor" />
        <Text size={textSize} weight={600} lh={1.2}>
          {withAbbreviation ? abbreviateNumber(user.balance) : user.balance.toLocaleString()}
        </Text>
      </Group>
    </Text>
  );

  return withTooltip ? (
    <Tooltip label={`Total balance: ${user.balance.toLocaleString()}`}>{content}</Tooltip>
  ) : (
    content
  );
}
