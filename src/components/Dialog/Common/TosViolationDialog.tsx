import { Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ViolationType } from '~/server/common/enums';
import { TOS_REASONS } from '~/server/common/tos-reasons';
import { showErrorNotification } from '~/utils/notifications';

export default function TosViolationDialog({
  title,
  message,
  onConfirm,
}: {
  title?: React.ReactNode;
  message?: React.ReactNode;
  onConfirm?: (
    violationType: ViolationType,
    violationDetails?: string
  ) => Promise<unknown> | unknown;
}) {
  const dialog = useDialogContext();
  const [loading, setLoading] = useState(false);
  const [violationType, setViolationType] = useState<string | null>(null);
  const [violationDetails, setViolationDetails] = useState('');

  const handleCancel = () => {
    dialog.onClose();
  };

  const handleConfirm = async () => {
    if (!violationType) return;
    try {
      setLoading(true);
      await onConfirm?.(violationType as ViolationType, violationDetails || undefined);
      dialog.onClose();
    } catch (error) {
      showErrorNotification({
        error: error instanceof Error ? error : new Error('Failed to confirm TOS violation'),
        title: 'Failed to remove image',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      {...dialog}
      title={<Text className="font-semibold">{title}</Text>}
      onClose={handleCancel}
      centered
      styles={{ content: { overflow: 'visible' } }}
    >
      <Stack>
        {message && <Text>{message}</Text>}
        <Text size="sm">Select the violation type for this image.</Text>
        <Select
          label="Violation Type"
          placeholder="Select violation type..."
          data={TOS_REASONS}
          value={violationType}
          onChange={setViolationType}
          comboboxProps={{
            withinPortal: false,
            zIndex: 1000,
            position: 'bottom',
            middlewares: { flip: false, shift: false },
          }}
          allowDeselect={false}
          searchable
          required
        />
        <Textarea
          label="Additional Details (optional)"
          placeholder="Add context about this violation..."
          value={violationDetails}
          onChange={(e) => setViolationDetails(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} loading={loading} color="red" disabled={!violationType}>
            Remove as TOS Violation
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
