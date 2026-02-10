import { Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { TOS_REASONS } from '~/server/common/tos-reasons';

export default function TosViolationDialog({
  title,
  message,
  onConfirm,
}: {
  title?: React.ReactNode;
  message?: React.ReactNode;
  onConfirm?: (violationType: string, violationDetails?: string) => Promise<unknown> | unknown;
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
    const result = onConfirm?.(violationType, violationDetails || undefined);
    if (result instanceof Promise) {
      setLoading(true);
      await Promise.resolve(result);
      setLoading(false);
    }
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
        {message && <Text>{message}</Text>}
        <Text size="sm">Select the violation type for this image.</Text>
        <Select
          label="Violation Type"
          placeholder="Select violation type..."
          data={TOS_REASONS.map((r) => ({ value: r.violationType, label: r.label }))}
          value={violationType}
          onChange={setViolationType}
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
          <Button
            onClick={handleConfirm}
            loading={loading}
            color="red"
            disabled={!violationType}
          >
            Remove as TOS Violation
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
