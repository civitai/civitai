import { Badge, Text, Group, useComputedColorScheme, useMantineTheme, rgba } from '@mantine/core';
import { UserBuzz } from '~/components/User/UserBuzz';

export const AvailableBuzzBadge = () => {
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
        <Text size="xs" color="dimmed" transform="capitalize" weight={600}>
          Available Buzz
        </Text>
        <UserBuzz iconSize={16} textSize="sm" accountType="user" withTooltip />
      </Group>
    </Badge>
  );
};
