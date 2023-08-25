import { showNotification } from '@mantine/notifications';
import { IconBolt, IconCheck, IconX } from '@tabler/icons-react';
import { Group, ThemeIcon } from '@mantine/core';

export function showErrorNotification({
  error,
  reason,
  title,
}: {
  error: Error;
  reason?: string;
  title?: string;
}) {
  console.error(error);
  const message = reason ?? error.message;

  showNotification({
    icon: <IconX size={18} />,
    color: 'red',
    message,
    title,
  });
}

export function showSuccessNotification({
  message,
  title,
  autoClose = false,
}: {
  message: string;
  title?: string;
  autoClose?: number | false;
}) {
  showNotification({
    icon: <IconCheck size={18} />,
    color: 'teal',
    message,
    title,
    autoClose,
  });
}
export function showBuzzNotification({
  message,
  title,
}: {
  message: React.ReactNode;
  title?: string;
}) {
  showNotification({
    color: 'yellow.4',
    message: (
      <Group spacing={4}>
        {/* @ts-ignore: ignoring ts error cause `transparent` works on variant */}
        <ThemeIcon color="yellow.4" variant="transparent">
          <IconBolt size={18} fill="currentColor" />
        </ThemeIcon>
        {message}
      </Group>
    ),
    title,
  });
}
