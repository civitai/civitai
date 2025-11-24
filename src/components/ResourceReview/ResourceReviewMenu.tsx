import type { MenuProps } from '@mantine/core';
import { ActionIcon, Loader, Menu, Text } from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import {
  IconCalculator,
  IconCalculatorOff,
  IconDotsVertical,
  IconEdit,
  IconFlag,
  IconLock,
  IconTrash,
} from '@tabler/icons-react';

import { ToggleLockComments } from '~/components/CommentsV2/ToggleLockComments';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { ResourceReviewPagedModel } from '~/types/router';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { openResourceReviewEditModal } from '~/components/Dialog/triggers/resource-review-edit';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function ResourceReviewMenu({
  reviewId,
  userId,
  size = 'sm',
  review,
  ...props
}: {
  reviewId: number;
  userId: number;
  size?: MantineSpacing;
  review: Pick<
    ResourceReviewPagedModel,
    | 'id'
    | 'rating'
    | 'modelId'
    | 'modelVersionId'
    | 'recommended'
    | 'details'
    | 'exclude'
    | 'metadata'
  >;
} & MenuProps) {
  const currentUser = useCurrentUser();
  const dialog = useDialogContext();

  const isMod = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === userId;
  const isMuted = currentUser?.muted ?? false;

  const queryUtils = trpc.useUtils();
  const deleteMutation = trpc.resourceReview.delete.useMutation({
    onSuccess: async () => {
      closeAllModals();
      dialog.onClose();
      await queryUtils.resourceReview.invalidate();
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
          Are you sure you want to exclude this review from the count of this model? You will not be
          able to revert this.
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
        <LegacyActionIcon size={size} variant="subtle">
          <IconDotsVertical size={16} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {(isOwner || isMod) && (
          <>
            <Menu.Item
              leftSection={<IconTrash size={14} stroke={1.5} />}
              color="red"
              onClick={handleDelete}
            >
              Delete review
            </Menu.Item>
            {!isMuted && (
              <Menu.Item
                leftSection={<IconEdit size={14} stroke={1.5} />}
                onClick={() => openResourceReviewEditModal(review)}
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
                leftSection={<IconCalculatorOff size={14} stroke={1.5} />}
                onClick={handleExcludeReview}
              >
                Exclude from count
              </Menu.Item>
            ) : review.metadata?.excludeReason !== 'reviewManipulation' ? (
              <Menu.Item
                leftSection={<IconCalculator size={14} stroke={1.5} />}
                onClick={handleUnexcludeReview}
              >
                Include into count
              </Menu.Item>
            ) : null}
            <ToggleLockComments entityId={reviewId} entityType="review">
              {({ toggle, locked, isLoading }) => {
                return (
                  <Menu.Item
                    leftSection={
                      isLoading ? <Loader size={14} /> : <IconLock size={14} stroke={1.5} />
                    }
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
              leftSection={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openReportModal({
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
