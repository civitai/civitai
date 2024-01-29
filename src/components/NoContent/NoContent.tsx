import { Stack, StackProps, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';

const ICON_CONTAINER_SIZE_RATIO = 1.6;

export function NoContent({
  message,
  iconSize = 128,
  children,
  ...props
}: Omit<StackProps, 'align'> & { message?: string; iconSize?: number }) {
  return (
    <Stack {...props} align="center">
      <ThemeIcon size={iconSize} radius={100}>
        <IconCloudOff size={iconSize / ICON_CONTAINER_SIZE_RATIO} />
      </ThemeIcon>
      <Text size={32} align="center">
        No results found
      </Text>
      <Text align="center">
        {message ?? "Try adjusting your search or filters to find what you're looking for"}
      </Text>
      {children}
    </Stack>
  );
}
