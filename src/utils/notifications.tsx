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

export function showSuccessNotification({ message, title }: { message: string; title?: string }) {
  showNotification({
    icon: <IconCheck size={18} />,
    color: 'teal',
    message,
    title,
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
      <Group>
        <ThemeIcon color="yellow.4">
          <IconBolt size={18} />
        </ThemeIcon>
        {message}
      </Group>
    ),
    title,
  });
}
