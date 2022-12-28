import { closeAllModals, openConfirmModal } from '@mantine/modals';
import React from 'react';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { Text } from '@mantine/core';

export function DeleteAnswer({ children, id }: { children: React.ReactElement; id: number }) {
  const { mutate, isLoading } = trpc.answer.delete.useMutation({
    onSuccess() {
      showSuccessNotification({
        title: 'Your answer has been deleted',
        message: 'Successfully deleted the answer',
      });
      closeAllModals();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete answer',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });

  const handleDeleteAnswer = () => {
    openConfirmModal({
      title: 'Delete answer',
      children: (
        <Text size="sm">
          Are you sure you want to delete this answer? This action is destructive and you will have
          to contact support to restore your data.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete answer', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: isLoading },
      closeOnConfirm: false,
      onConfirm: () => mutate({ id }),
    });
  };

  return React.cloneElement(children, { onClick: handleDeleteAnswer });
}
