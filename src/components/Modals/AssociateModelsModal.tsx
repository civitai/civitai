import { CloseButton, Stack, Text, Group, Modal } from '@mantine/core';
import type { AssociationType } from '~/shared/utils/prisma/enums';
import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export default function AssociateModelsModal({
  fromId,
  type,
}: {
  fromId: number;
  type: AssociationType;
}) {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} withCloseButton={false}>
      <Stack>
        <Group wrap="nowrap" justify="space-between">
          <Text>{`Manage ${type} Resources`}</Text>
          <CloseButton onClick={dialog.onClose} />
        </Group>
        <AssociateModels fromId={fromId} type={type} onSave={dialog.onClose} />
      </Stack>
    </Modal>
  );
}
