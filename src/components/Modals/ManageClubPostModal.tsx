import { createContextModal } from '~/components/Modals/utils/createContextModal';
import React from 'react';
import { ClubPostManageForm, ClubPostManageFormProps } from '~/components/Club/ClubPostManageForm';

const { openModal, Modal } = createContextModal<
  Omit<ClubPostManageFormProps, 'onSave' | 'onCancel'>
>({
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

    return <ClubPostManageForm {...props} onSave={handleClose} onCancel={handleClose} />;
  },
});

export const openManageClubPostModal = openModal;
export default Modal;
