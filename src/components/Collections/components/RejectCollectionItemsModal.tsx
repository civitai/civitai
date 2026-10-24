import { Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SELECTABLE_REJECTION_REASONS } from '~/shared/constants/collection-rejection.constants';
import type { CollectionItemRejectionReason } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

export type RejectionSelection = {
  rejectionReason?: CollectionItemRejectionReason;
};

function RejectCollectionItemsModal({
  count,
  onConfirm,
}: {
  count: number;
  onConfirm: (selection: RejectionSelection) => void;
}) {
  const dialog = useDialogContext();
  const [reason, setReason] = useState<CollectionItemRejectionReason | null>(null);

  const handleConfirm = () => {
    onConfirm({ rejectionReason: reason ?? undefined });
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      title={
        <Text className="font-semibold">
          Reject {count} {count === 1 ? 'entry' : 'entries'}
        </Text>
      }
      centered
    >
      <Stack>
        <Select
          label="Reason"
          description="Shown to the submitter in their notification. Optional."
          placeholder="No reason"
          clearable
          comboboxProps={{ withinPortal: true }}
          data={SELECTABLE_REJECTION_REASONS.map((value) => ({
            value,
            label: getDisplayName(value),
          }))}
          value={reason}
          onChange={(value) => setReason((value as CollectionItemRejectionReason | null) ?? null)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button color="red" onClick={handleConfirm}>
            Reject
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function openRejectCollectionItemsModal(props: {
  count: number;
  onConfirm: (selection: RejectionSelection) => void;
}) {
  dialogStore.trigger({ component: RejectCollectionItemsModal, props });
}
