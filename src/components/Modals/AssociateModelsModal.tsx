import { CloseButton, Stack, Text, Group } from '@mantine/core';
import { AssociationType } from '@prisma/client';
import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';
import { createContextModal } from '~/components/Modals/utils/createContextModal';

const { openModal, Modal } = createContextModal<{
  fromId: number;
  type: AssociationType;
}>({
  name: 'associateModels',
  withCloseButton: false,
  size: 600,
  Element: ({ context, props: { fromId, type } }) => {
    return (
      <Stack>
        <Group noWrap position="apart">
          <Text>{`Manage ${type} Resources`}</Text>
          <CloseButton onClick={context.close} />
        </Group>
        <AssociateModels fromId={fromId} type={type} onSave={context.close} />
      </Stack>
    );
  },
});

export const openAssociateModelsModal = openModal;
export default Modal;
