import { createContextModal } from '~/components/Modals/utils/createContextModal';
import React from 'react';
import {
  ClubEntityManageForm,
  ClubEntityManageFormProps,
} from '~/components/Club/ClubEntityManageForm';
import { showSuccessNotification } from '~/utils/notifications';
import Link from 'next/link';
import { Anchor } from '@mantine/core';

const { openModal, Modal } = createContextModal<
  Omit<ClubEntityManageFormProps, 'onSave' | 'onCancel'>
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
      <ClubEntityManageForm
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
