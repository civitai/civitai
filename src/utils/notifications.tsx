import { showNotification } from '@mantine/notifications';
import { IconCheck, IconX } from '@tabler/icons-react';

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
