import { ActionIcon, Loader, MantineNumberSize, Menu, MenuProps, Text } from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import {
  IconCalculator,
  IconCalculatorOff,
  IconDotsVertical,
  IconEdit,
  IconFlag,
  IconLock,
  IconTrash,
} from '@tabler/icons';

import { ToggleLockComments } from '~/components/CommentsV2';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { closeRoutedContext } from '~/providers/RoutedContextProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ResourceReviewMenu({
  reviewId,
  userId,
  size = 'sm',
  review,
  ...props
}: {
  reviewId: number;
  userId: number;
  size?: MantineNumberSize;
  review: {
    id: number;
    rating: number;
    details?: string;
    modelId: number;
    modelVersionId: number;
    exclude?: boolean;
  };
} & MenuProps) {
  const currentUser = useCurrentUser();

  const isMod = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === userId;
  const isMuted = currentUser?.muted ?? false;

  const queryUtils = trpc.useContext();
  const deleteMutation = trpc.resourceReview.delete.useMutation({
    onSuccess: async () => {
      await queryUtils.resourceReview.invalidate();
      closeAllModals();
      closeRoutedContext();
    },
  });
  const handleDelete = () => {
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
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        deleteMutation.mutate({ id: reviewId });
      },
    });
  };

  const excludeMutation = trpc.resourceReview.toggleExclude.useMutation({
    async onSuccess() {
      await queryUtils.resourceReview.invalidate();
      closeAllModals();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not exclude review',
      });
    },
  });
  const handleExcludeReview = () => {
    openConfirmModal({
      title: 'Exclude Review',
      children: (
        <Text size="sm">
          Are you sure you want to exclude this review from the average score of this model? You
          will not be able to revert this.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Exclude Review', cancel: "No, don't exclude it" },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        excludeMutation.mutate({ id: review.id });
      },
    });
  };
  const handleUnexcludeReview = () => excludeMutation.mutate({ id: review.id });

  return (
    <Menu position="bottom-end" withinPortal {...props}>
      <Menu.Target>
        <ActionIcon size={size} variant="subtle">
          <IconDotsVertical size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {(isOwner || isMod) && (
          <>
            <Menu.Item
              icon={<IconTrash size={14} stroke={1.5} />}
              color="red"
              onClick={handleDelete}
            >
              Delete review
            </Menu.Item>
            {!isMuted && (
              <Menu.Item
                icon={<IconEdit size={14} stroke={1.5} />}
                onClick={() => openContext('resourceReviewEdit', review)}
              >
                Edit review
              </Menu.Item>
            )}
          </>
        )}
        {isMod && (
          <>
            {!review.exclude ? (
              <Menu.Item
                icon={<IconCalculatorOff size={14} stroke={1.5} />}
                onClick={handleExcludeReview}
              >
                Exclude from average
              </Menu.Item>
            ) : (
              <Menu.Item
                icon={<IconCalculator size={14} stroke={1.5} />}
                onClick={handleUnexcludeReview}
              >
                Unexclude from average
              </Menu.Item>
            )}
            <ToggleLockComments entityId={reviewId} entityType="review">
              {({ toggle, locked, isLoading }) => {
                return (
                  <Menu.Item
                    icon={isLoading ? <Loader size={14} /> : <IconLock size={14} stroke={1.5} />}
                    onClick={toggle}
                    disabled={isLoading}
                  >
                    {locked ? 'Unlock' : 'Lock'} Comments
                  </Menu.Item>
                );
              }}
            </ToggleLockComments>
          </>
        )}
        {!isOwner && (
          <LoginRedirect reason="report-review">
            <Menu.Item
              icon={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openContext('report', {
                  entityType: ReportEntity.ResourceReview,
                  entityId: reviewId,
                })
              }
            >
              Report
            </Menu.Item>
          </LoginRedirect>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
