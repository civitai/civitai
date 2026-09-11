import { Stack, Text, Title, Modal } from '@mantine/core';
import type { AssociationType } from '~/shared/utils/prisma/enums';
import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { getDisplayName } from '~/utils/string-helpers';

export default function AssociateModelsModal({
  fromId,
  type,
  ownerId,
}: {
  fromId: number;
  type: AssociationType;
  ownerId: number;
}) {
  const dialog = useDialogContext();

  return (
    <Modal
      {...dialog}
      title={
        <Stack gap={2}>
          <Title order={3}>{`Manage ${getDisplayName(type)} Resources`}</Title>
          <Text size="sm" c="dimmed">
            Drag to reorder — visitors see them in this order
          </Text>
        </Stack>
      }
      styles={{ header: { alignItems: 'flex-start' } }}
      centered
    >
      <AssociateModels fromId={fromId} type={type} ownerId={ownerId} onSave={dialog.onClose} />
    </Modal>
  );
}
