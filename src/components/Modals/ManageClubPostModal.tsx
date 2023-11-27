import { createContextModal } from '~/components/Modals/utils/createContextModal';
import React from 'react';

const { openModal, Modal } = createContextModal<{
  entityId: number;
  entityType: string;
}>({
  name: 'manageClubPostModal',
  withCloseButton: false,
  centered: true,
  size: 'lg',
  radius: 'lg',
  zIndex: 400,
  Element: ({ context, props: { ...props } }) => {
    const handleClose = () => {
      context.close();
    };

    return <span>TODO</span>;
  },
});

export const openManageClubPostModal = openModal;
export default Modal;
