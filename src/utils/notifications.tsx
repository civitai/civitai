import { Button, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { NotificationData, showNotification } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconExclamationMark,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react';

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

export function showWarningNotification({
  message,
  title,
  autoClose = 3000,
}: {
  message: string | React.ReactNode;
  title?: string;
  autoClose?: number | false;
}) {
  showNotification({
    icon: <IconExclamationMark size={18} />,
    color: 'orange',
    message,
    title,
    autoClose,
  });
}

export function showInfoNotification({
  message,
  title,
  autoClose = 3000,
}: {
  message: string | React.ReactNode;
  title?: string;
  autoClose?: number | false;
}) {
  showNotification({
    icon: <IconInfoCircle size={18} />,
    color: 'blue',
    message,
    title,
    autoClose,
  });
}

export function showBuzzNotification({
  message,
  title,
  ...notificationProps
}: NotificationData & {
  message: React.ReactNode;
}) {
  showNotification({
    color: 'yellow.4',
    message: (
      <Group gap={4} wrap="nowrap">
        {/* @ts-ignore: ignoring ts error cause `transparent` works on variant */}
        <ThemeIcon color={notificationProps.color ?? 'yellow.4'} variant="transparent">
          <IconBolt size={18} fill="currentColor" />
        </ThemeIcon>
        {message}
      </Group>
    ),
    // Hide title on mobile for smaller notifications
    title: (
      <Text className="hide-mobile" inherit>
        {title}
      </Text>
    ),
    ...notificationProps,
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
        <Group justify="flex-end">
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
    withCloseButton: false,
  });
}

export function showExpiredCaptchaTokenNotification({
  onRetryClick,
}: {
  onRetryClick: VoidFunction;
}) {
  showNotification({
    icon: <IconAlertTriangle size={18} />,
    color: 'yellow',
    title: 'Captcha token expired',
    message: (
      <div>
        <Text inherit>Your token expired, click the button below to reset your token</Text>
        <Button size="sm" variant="subtle" onClick={onRetryClick}>
          Reset
        </Button>
      </div>
    ),
  });
}
