import { Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons';
import React from 'react';

export function Empty({ title = 'No results found', message }: Props) {
  return (
    <Stack align="center">
      <ThemeIcon size={128} radius={100}>
        <IconCloudOff size={80} />
      </ThemeIcon>
      <Text size={32} align="center">
        {title}
      </Text>
      <Text align="center">{message}</Text>
    </Stack>
  );
}

type Props = {
  message: string;
  title?: string;
};
