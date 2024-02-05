import { Badge, Text, Group } from '@mantine/core';
import { UserBuzz } from '~/components/User/UserBuzz';

export const AvailableBuzzBadge = () => {
  return (
    <Badge
      radius="xl"
      variant="filled"
      h="auto"
      py={4}
      px={12}
      sx={(theme) => ({
        backgroundColor:
          theme.colorScheme === 'dark' ? theme.fn.rgba('#000', 0.31) : theme.colors.gray[0],
      })}
    >
      <Group spacing={4} noWrap>
        <Text size="xs" color="dimmed" transform="capitalize" weight={600}>
          Available Buzz
        </Text>
        <UserBuzz iconSize={16} textSize="sm" withTooltip />
      </Group>
    </Badge>
  );
};
