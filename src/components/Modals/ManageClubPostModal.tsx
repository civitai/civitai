import { createContextModal } from '~/components/Modals/utils/createContextModal';
import React from 'react';
import { ClubPostManageForm, ClubPostManageFormProps } from '~/components/Club/ClubPostManageForm';
import { showSuccessNotification } from '~/utils/notifications';
import Link from 'next/link';
import { Anchor } from '@mantine/core';

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

    return (
      <ClubPostManageForm
        {...props}
        onSave={({ entityId, entityType, isUpdate, clubId }) => {
          showSuccessNotification({
            title: `Your post has been ${isUpdate ? 'updated' : 'created'}`,
            message: (
              <Link href={`/club/${clubId}/${entityType.toLowerCase()}/${entityId}`}>
                <Anchor>Go to {entityType} post</Anchor>
              </Link>
            ),
          });

          handleClose();
        }}
        onCancel={handleClose}
      />
    );
  },
});

export const openManageClubPostModal = openModal;
export default Modal;
