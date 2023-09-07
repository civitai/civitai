import { Group, ThemeIcon } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { IconBolt, IconCheck, IconX } from '@tabler/icons-react';

export function showErrorNotification({
  error,
  reason,
  title,
  autoClose = 3000,
}: {
  error: Error;
  reason?: string;
  title?: string;
  autoClose?: number | false;
}) {
  console.error(error);
  const message = reason ?? error.message;

  showNotification({
    icon: <IconX size={18} />,
    color: 'red',
    message,
    title,
    autoClose,
  });
}

export function showSuccessNotification({
  message,
  title,
  autoClose = 3000,
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
