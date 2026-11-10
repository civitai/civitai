import type { StackProps } from '@mantine/core';
import type { ReactNode } from 'react';
import { Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';

const ICON_CONTAINER_SIZE_RATIO = 1.6;

export function NoContent({
  message,
  title = 'No results found',
  icon,
  iconSize = 128,
  children,
  ...props
}: Omit<StackProps, 'align' | 'title'> & {
  message?: string;
  title?: string;
  icon?: ReactNode;
  iconSize?: number;
}) {
  return (
    <Stack {...props} align="center">
      <ThemeIcon size={iconSize} radius={100}>
        {icon ?? <IconCloudOff size={iconSize / ICON_CONTAINER_SIZE_RATIO} />}
      </ThemeIcon>
      <Text fz={32} align="center">
        {title}
      </Text>
      <Text align="center">
        {message ?? "Try adjusting your search or filters to find what you're looking for"}
      </Text>
      {children}
    </Stack>
  );
}
