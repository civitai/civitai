import { showNotification } from '@mantine/notifications';
import { IconCheck, IconX } from '@tabler/icons';

export function showErrorNotification({
  error,
  reason,
  title,
}: {
  error: Error;
  reason?: string;
  title?: string;
}) {
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
