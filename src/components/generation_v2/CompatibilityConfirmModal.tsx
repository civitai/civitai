/**
 * CompatibilityConfirmModal
 *
 * A confirmation modal shown when the user selects an incompatible
 * workflow or ecosystem combination.
 */

import { Button, Card, Group, Modal, Stack, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';

// =============================================================================
// Types
// =============================================================================

export type PendingChange =
  | {
      type: 'workflow';
      value: string;
      workflowLabel: string;
      currentEcosystem: string;
      targetEcosystem: string;
    }
  | {
      type: 'ecosystem';
      value: string;
      ecosystemLabel: string;
      currentWorkflow: string;
      targetWorkflow: string;
    };

export interface CompatibilityConfirmModalProps {
  pendingChange: PendingChange;
  onConfirm: () => void;
}

// =============================================================================
// Dialog Store Component (used internally)
// =============================================================================

function CompatibilityConfirmModalContent({
  pendingChange,
  onConfirm,
}: CompatibilityConfirmModalProps) {
  const dialog = useDialogContext();

  const isWorkflowChange = pendingChange.type === 'workflow';

  const handleConfirm = () => {
    onConfirm();
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      onClose={dialog.onClose}
      title={isWorkflowChange ? 'Change ecosystem?' : 'Change workflow?'}
      size="sm"
      centered
    >
      <Stack gap="md">
        <Text size="sm">
          {isWorkflowChange ? (
            <>
              <strong>{pendingChange.workflowLabel}</strong> is not available for{' '}
              <strong>{pendingChange.currentEcosystem}</strong>.
            </>
          ) : (
            <>
              <strong>{pendingChange.ecosystemLabel}</strong> doesn&apos;t support{' '}
              <strong>{pendingChange.currentWorkflow}</strong>.
            </>
          )}
        </Text>

        <Card withBorder p="sm" className="bg-gray-0 dark:bg-dark-6">
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" c="dimmed">
              {isWorkflowChange ? 'Ecosystem' : 'Workflow'}
            </Text>
            <Text size="sm" fw={500} className="line-through opacity-60">
              {isWorkflowChange ? pendingChange.currentEcosystem : pendingChange.currentWorkflow}
            </Text>
            <IconArrowRight size={14} className="text-gray-5" />
            <Text size="sm" fw={600} c="blue">
              {isWorkflowChange ? pendingChange.targetEcosystem : pendingChange.targetWorkflow}
            </Text>
          </Group>
        </Card>

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Continue</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// =============================================================================
// Trigger Function
// =============================================================================

/**
 * Opens the compatibility confirmation modal via dialogStore.
 * This ensures proper z-index stacking when opened from other modals.
 */
export function openCompatibilityConfirmModal(props: CompatibilityConfirmModalProps) {
  dialogStore.trigger({
    id: 'compatibility-confirm',
    component: CompatibilityConfirmModalContent,
    props,
  });
}
