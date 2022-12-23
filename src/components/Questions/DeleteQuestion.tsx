import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { useRouter } from 'next/router';
import React from 'react';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { Text } from '@mantine/core';

export function DeleteQuestion({ children, id }: { children: React.ReactElement; id: number }) {
  const router = useRouter();

  const { mutate, isLoading } = trpc.question.delete.useMutation({
    onSuccess() {
      showSuccessNotification({
        title: 'Your question has been deleted',
        message: 'Successfully deleted the question',
      });
      closeAllModals();
      router.replace('/questions'); // Redirect to the models or user page once available
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete question',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });

  const handleDeleteQuestion = () => {
    openConfirmModal({
      title: 'Delete question',
      children: (
        <Text size="sm">
          Are you sure you want to delete this question? This action is destructive and you will
          have to contact support to restore your data.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete question', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: isLoading },
      closeOnConfirm: false,
      onConfirm: () => mutate({ id }),
    });
  };

  return React.cloneElement(children, { onClick: handleDeleteQuestion });
}
