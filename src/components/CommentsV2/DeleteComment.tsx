import { closeAllModals, openConfirmModal } from '@mantine/modals';
import React from 'react';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { Text } from '@mantine/core';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';

export function DeleteComment({
  children,
  id,
  entityId,
  entityType,
}: { children: React.ReactElement; id: number } & CommentConnectorInput) {
  const queryUtils = trpc.useContext();
  const { mutate, isLoading } = trpc.commentv2.delete.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Your comment has been deleted',
        message: 'Successfully deleted the comment',
      });
      closeAllModals();
      //TODO.comments - possiby add optimistic updates
      queryUtils.commentv2.getCount.setData({ entityId, entityType }, (old = 1) => old - 1);
      await queryUtils.commentv2.getInfinite.invalidate({ entityId, entityType });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete comment',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });

  const handleDeleteComment = () => {
    openConfirmModal({
      title: 'Delete comment',
      children: <Text size="sm">Are you sure you want to delete this comment?</Text>,
      centered: true,
      labels: { confirm: 'Delete comment', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: isLoading },
      closeOnConfirm: false,
      onConfirm: () => mutate({ id }),
    });
  };

  return React.cloneElement(children, { onClick: handleDeleteComment });
}
