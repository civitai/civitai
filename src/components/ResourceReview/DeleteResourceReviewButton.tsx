import { Text } from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { closeRoutedContext } from '~/providers/RoutedContextProvider';
import { closeAllModals, openConfirmModal } from '@mantine/modals';

export function DeleteResourceReviewButton({
  reviewId,
  children,
}: {
  reviewId: number;
  children: ({
    onClick,
    isLoading,
  }: {
    onClick: () => void;
    isLoading?: boolean;
  }) => React.ReactElement;
}) {
  const queryUtils = trpc.useContext();
  const { mutate, isLoading } = trpc.resourceReview.delete.useMutation({
    onSuccess: async () => {
      await queryUtils.resourceReview.invalidate();
      closeAllModals();
      closeRoutedContext();
    },
  });
  const onClick = () => {
    openConfirmModal({
      title: 'Delete Review',
      children: (
        <Text size="sm">
          Are you sure you want to delete this review? This action is destructive and cannot be
          reverted.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete Review', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        mutate({ id: reviewId });
      },
    });
  };
  return children({ onClick, isLoading });
}
