/**
 * SwitchToNewFormModal
 *
 * Shown when a user on the legacy generation form tries to remix something
 * that uses features only available in the new generation form (e.g., Kling V3, Veo3 ref2vid).
 */

import { Button, Group, Modal, Stack, Text } from '@mantine/core';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';

// =============================================================================
// Types
// =============================================================================

interface SwitchToNewFormModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

// =============================================================================
// Component
// =============================================================================

function SwitchToNewFormModalContent({ onConfirm, onCancel }: SwitchToNewFormModalProps) {
  const dialog = useDialogContext();

  const handleConfirm = () => {
    onConfirm();
    dialog.onClose();
  };

  const handleCancel = () => {
    onCancel();
    dialog.onClose();
  };

  return (
    <Modal {...dialog} onClose={handleCancel} title="Switch to new generator?" size="sm" centered>
      <Stack gap="md">
        <Text size="sm">
          This uses features only available in the new generator. Switch now to continue.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Switch</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// =============================================================================
// Trigger
// =============================================================================

export function openSwitchToNewFormModal(props: SwitchToNewFormModalProps) {
  dialogStore.trigger({
    id: 'switch-to-new-form',
    component: SwitchToNewFormModalContent,
    props,
  });
}
