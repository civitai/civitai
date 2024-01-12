import { Button, Group, Stack, ThemeIcon } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { IconBolt, IconCheck, IconX } from '@tabler/icons-react';

export function showErrorNotification({
  error,
  reason,
  title,
  autoClose = 3000,
}: {
  error: Error | { message: string } | { message: string }[];
  reason?: string;
  title?: string;
  autoClose?: number | false;
}) {
  const message = Array.isArray(error) ? (
    <ul>
      {error.map((e, index) => (
        <li key={index}>{e.message}</li>
      ))}
    </ul>
  ) : (
    reason ?? error.message
  );

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
  message: string | React.ReactNode;
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

export function showConfirmNotification({
  id,
  message,
  title = 'Please confirm your action',
  color,
  onConfirm,
  onCancel,
  autoClose = 8000,
}: {
  message: React.ReactNode;
  title?: string;
  color?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  autoClose?: number | false;
  id?: string;
}) {
  showNotification({
    id,
    color,
    message: (
      <Stack>
        {message}
        <Group position="right">
          {onCancel && (
            <Button onClick={onCancel} variant="outline" color="red">
              Cancel
            </Button>
          )}
          {onConfirm && (
            <Button color={color} variant="filled" onClick={onConfirm}>
              Confirm
            </Button>
          )}
        </Group>
      </Stack>
    ),
    title,
    autoClose,
    disallowClose: true,
  });
}
