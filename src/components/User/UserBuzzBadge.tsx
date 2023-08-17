import { Badge, BadgeProps, Group, Text, useMantineTheme } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { CivitaiSessionState } from '~/components/CivitaiWrapped/CivitaiSessionProvider';

type Props = BadgeProps & { user: CivitaiSessionState | null; iconSize?: number };

export function UserBuzzBadge({ user, iconSize = 14, ...badgeProps }: Props) {
  const theme = useMantineTheme();

  if (!user) return null;

  return (
    <Badge
      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      px={8}
      py={6}
      size="lg"
      radius="sm"
      sx={(theme) => ({
        backgroundColor:
          theme.colorScheme === 'dark' ? theme.fn.rgba('#fff', 0.12) : theme.colors.blue[0],
      })}
      {...badgeProps}
    >
      <Group spacing={4} noWrap>
        <IconBolt
          size={iconSize}
          color={theme.colorScheme === 'dark' ? 'white' : theme.colors.blue[6]}
          fill={theme.colorScheme === 'dark' ? 'white' : theme.colors.blue[6]}
        />
        <Text size={badgeProps.size === 'xs' ? 'xs' : 'sm'} weight={600} lh={1.2}>
          {abbreviateNumber(user?.balance ?? 0)}
        </Text>
      </Group>
    </Badge>
  );
}
