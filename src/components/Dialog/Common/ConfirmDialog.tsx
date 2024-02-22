import { Button, Group, Modal, Stack } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
}: {
  title?: string;
  message: React.ReactNode;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  const dialog = useDialogContext();

  const handleCancel = () => {
    dialog.onClose();
    onCancel?.();
  };

  const handleConfirm = () => {
    dialog.onClose();
    onConfirm?.();
  };

  return (
    <Modal {...dialog} title={title} onClose={handleCancel}>
      <Stack>
        {message}
        <Group position="right">
          <Button variant="outline" compact onClick={handleCancel}>
            No
          </Button>
          <Button compact onClick={handleConfirm}>
            Yes
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
