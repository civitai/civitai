import { Text } from '@mantine/core';
import { useCommentsContext } from '../CommentsProvider';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import React from 'react';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function DeleteComment({
  children,
  id,
  entityId,
  entityType,
}: {
  children: ({
    onClick,
    isLoading,
  }: {
    onClick: () => void;
    isLoading?: boolean;
  }) => React.ReactElement;
  id: number;
} & CommentConnectorInput) {
  const queryUtils = trpc.useContext();
  const { created, setCreated } = useCommentsContext();
  const { mutate, isLoading } = trpc.commentv2.delete.useMutation({
    async onSuccess(response, request) {
      showSuccessNotification({
        title: 'Your comment has been deleted',
        message: 'Successfully deleted the comment',
      });
      if (created.some((x) => x.id === request.id)) {
        setCreated((state) => state.filter((x) => x.id !== request.id));
      } else {
        //TODO.comments - possiby add optimistic updates
        await queryUtils.commentv2.getInfinite.invalidate({ entityId, entityType });
      }
      queryUtils.commentv2.getCount.setData({ entityId, entityType }, (old = 1) => old - 1);
      closeAllModals();
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

  return children({ onClick: handleDeleteComment, isLoading });
}
