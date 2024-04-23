import { Button, Group, Modal, Stack, ButtonProps, Text } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
  labels,
  confirmProps,
  cancelProps,
}: {
  title?: React.ReactNode;
  message: React.ReactNode;
  onConfirm?: () => Promise<unknown> | unknown;
  onCancel?: () => void;
  labels?: { cancel?: string; confirm?: string };
  confirmProps?: ButtonProps;
  cancelProps?: ButtonProps;
}) {
  const dialog = useDialogContext();
  const [loading, setLoading] = useState(false);

  const handleCancel = () => {
    onCancel?.();
    dialog.onClose();
  };

  const handleConfirm = async () => {
    const result = onConfirm?.();
    if (result instanceof Promise) {
      setLoading(true);
      await Promise.resolve(result);
      setLoading(false);
    }
    // await onConfirm?.();
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      title={<Text className="font-semibold">{title}</Text>}
      onClose={handleCancel}
      centered
    >
      <Stack>
        {message}
        <Group position="right">
          <Button variant="default" onClick={handleCancel} {...cancelProps}>
            {labels?.cancel ?? 'No'}
          </Button>
          <Button onClick={handleConfirm} loading={loading} {...confirmProps}>
            {labels?.confirm ?? 'Yes'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
