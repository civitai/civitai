import { Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons';

export function NoContent() {
  return (
    <Stack align="center">
      <ThemeIcon size={128} radius={100}>
        <IconCloudOff size={80} />
      </ThemeIcon>
      <Text size={32} align="center">
        No results found
      </Text>
      <Text align="center">
        {"Try adjusting your search or filters to find what you're looking for"}
      </Text>
    </Stack>
  );
}
