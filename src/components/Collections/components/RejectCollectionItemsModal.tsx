import { Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SELECTABLE_REJECTION_REASONS } from '~/shared/constants/collection-rejection.constants';
import { CollectionItemRejectionReason } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

export type RejectionSelection = {
  rejectionReason?: CollectionItemRejectionReason;
  rejectionDetail?: string;
};

const MAX_DETAIL_LENGTH = 200;

function RejectCollectionItemsModal({
  count,
  onConfirm,
}: {
  count: number;
  onConfirm: (selection: RejectionSelection) => void;
}) {
  const dialog = useDialogContext();
  const [reason, setReason] = useState<CollectionItemRejectionReason | null>(null);
  const [detail, setDetail] = useState('');

  const isOther = reason === CollectionItemRejectionReason.Other;
  const detailMissing = isOther && !detail.trim().length;

  const handleConfirm = () => {
    onConfirm({
      rejectionReason: reason ?? undefined,
      rejectionDetail: isOther ? detail.trim() : undefined,
    });
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
        {isOther && (
          <Textarea
            label="What should we tell them?"
            placeholder="Keep it short — this goes straight to the submitter."
            maxLength={MAX_DETAIL_LENGTH}
            autosize
            minRows={2}
            value={detail}
            onChange={(event) => setDetail(event.currentTarget.value)}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button color="red" onClick={handleConfirm} disabled={detailMissing}>
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
