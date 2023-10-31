import { Stack } from '@mantine/core';
import React from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { trpc } from '~/utils/trpc';

const { openModal, Modal } = createContextModal<{ modelId: number; versionId?: number }>({
  name: 'userProfileEditModal',
  withCloseButton: false,
  Element: ({ context, props: { modelId, versionId } }) => {
    const queryUtils = trpc.useContext();
    return <Stack></Stack>;
  },
});

export const openUnpublishModal = openModal;
export default Modal;
