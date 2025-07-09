import { Badge, Text, Group, useComputedColorScheme, useMantineTheme, rgba } from '@mantine/core';
import { UserBuzz } from '~/components/User/UserBuzz';
import type { BuzzAccountType } from '~/server/schema/buzz.schema';

export const AvailableBuzzBadge = ({ buzzTypes = ['user'] }: { buzzTypes?: BuzzAccountType[] }) => {
  const colorScheme = useComputedColorScheme('dark');
  const theme = useMantineTheme();

  return (
    <Badge
      radius="xl"
      variant="filled"
      h="auto"
      py={4}
      px={12}
      style={{
        backgroundColor: colorScheme === 'dark' ? rgba('#000', 0.31) : theme.colors.gray[0],
      }}
    >
      <Group gap={4} wrap="nowrap">
        <Text size="xs" c="dimmed" tt="capitalize" fw={600}>
          Available Buzz
        </Text>
        <UserBuzz iconSize={16} textSize="sm" accountTypes={buzzTypes} withTooltip />
      </Group>
    </Badge>
  );
};
