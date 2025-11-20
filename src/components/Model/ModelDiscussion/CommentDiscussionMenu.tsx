import type { MenuProps } from '@mantine/core';
import { ActionIcon, Menu, Text } from '@mantine/core';
import { closeAllModals, closeModal, openConfirmModal } from '@mantine/modals';
import {
  IconDotsVertical,
  IconTrash,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconFlag,
  IconLock,
  IconLockOpen,
  IconBan,
} from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';

import { openReportModal } from '~/components/Dialog/triggers/report';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import type { CommentGetAllItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function CommentDiscussionMenu({
  comment,
  size = 'xs',
  hideLockOption = false,
  ...props
}: Props) {
  const queryUtils = trpc.useUtils();
  const dialog = useDialogContext();
  const user = useCurrentUser();

  const isMod = user?.isModerator ?? false;
  const isOwner = comment.user.id === user?.id;
  const isMuted = user?.muted ?? false;
  const { data: model } = trpc.model.getById.useQuery({ id: comment.modelId });
  const isModelOwner = model && user && model.user.id === user.id;

  const deleteMutation = trpc.comment.delete.useMutation({
    async onSuccess() {
      await queryUtils.comment.getAll.invalidate();
      closeAllModals();
      dialog.onClose();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete comment',
      });
    },
  });
  const handleDeleteComment = () => {
    openConfirmModal({
      title: 'Delete Comment',
      children: (
        <Text size="sm">
          Are you sure you want to delete this comment? This action is destructive and cannot be
          reverted.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete Comment', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        deleteMutation.mutate({ id: comment.id });
      },
    });
  };

  const toggleLockMutation = trpc.comment.toggleLock.useMutation({
    async onMutate({ id }) {
      await queryUtils.comment.getById.cancel();

      const prevComment = queryUtils.comment.getById.getData({ id });
      if (prevComment)
        queryUtils.comment.getById.setData({ id }, () => ({
          ...prevComment,
          locked: !prevComment.locked,
        }));

      return { prevComment };
    },
    async onSuccess() {
      await queryUtils.comment.getCommentsById.invalidate({ id: comment.id });
    },
    onError(_error, vars, context) {
      showErrorNotification({
        error: new Error('Could not lock the thread, please try again'),
      });
      queryUtils.comment.getById.setData({ id: vars.id }, context?.prevComment);
    },
  });
  const handleToggleLockThread = () => {
    toggleLockMutation.mutate({ id: comment.id });
  };

  const tosViolationMutation = trpc.comment.setTosViolation.useMutation({
    async onSuccess() {
      await queryUtils.comment.getById.invalidate({ id: comment.id });
      closeModal('confirm-tos-violation');
      dialog.onClose();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not report review, please try again',
      });
    },
  });
  const handleTosViolation = () => {
    openConfirmModal({
      modalId: 'confirm-tos-violation',
      title: 'Report ToS Violation',
      children: `Are you sure you want to report this comment as a Terms of Service violation?`,
      centered: true,
      labels: { confirm: 'Yes', cancel: 'Cancel' },
      confirmProps: { color: 'red', disabled: tosViolationMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => tosViolationMutation.mutate({ id: comment.id }),
    });
  };

  const toggleHideCommentMutation = trpc.comment.toggleHide.useMutation({
    async onMutate({ id }) {
      await queryUtils.comment.getById.cancel();

      const prevComment = queryUtils.comment.getById.getData({ id });
      if (prevComment)
        queryUtils.comment.getById.setData({ id }, () => ({
          ...prevComment,
          hidden: !prevComment.hidden,
        }));

      return { prevComment };
    },
    async onSuccess() {
      await queryUtils.comment.getAll.invalidate();
      await queryUtils.comment.getCommentCountByModel.invalidate({
        modelId: comment.modelId,
        hidden: true,
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Could not hide comment',
        error: new Error(error.message),
      });
    },
  });
  const handleToggleHideComment = () => {
    toggleHideCommentMutation.mutate({ id: comment.id });
  };

  return (
    <Menu position="bottom-end" withinPortal {...props}>
      <Menu.Target>
        <LegacyActionIcon size={size} variant="subtle">
          <IconDotsVertical size={14} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {(isOwner || isMod) && (
          <>
            <Menu.Item
              leftSection={<IconTrash size={14} stroke={1.5} />}
              color="red"
              onClick={handleDeleteComment}
            >
              Delete comment
            </Menu.Item>
            {((!comment.locked && !isMuted) || isMod) && (
              <Menu.Item
                leftSection={<IconEdit size={14} stroke={1.5} />}
                onClick={() =>
                  triggerRoutedDialog({ name: 'commentEdit', state: { commentId: comment.id } })
                }
              >
                Edit comment
              </Menu.Item>
            )}
          </>
        )}
        {isMod && !hideLockOption && (
          <Menu.Item
            leftSection={
              comment.locked ? (
                <IconLockOpen size={14} stroke={1.5} />
              ) : (
                <IconLock size={14} stroke={1.5} />
              )
            }
            onClick={handleToggleLockThread}
          >
            {comment.locked ? 'Unlock comment' : 'Lock comment'}
          </Menu.Item>
        )}
        {(isModelOwner || isMod) && (
          <Menu.Item
            leftSection={
              comment.hidden ? (
                <IconEye size={14} stroke={1.5} />
              ) : (
                <IconEyeOff size={14} stroke={1.5} />
              )
            }
            onClick={handleToggleHideComment}
          >
            {comment.hidden ? 'Unhide comment' : 'Hide comment'}
          </Menu.Item>
        )}
        {isMod && (
          <Menu.Item leftSection={<IconBan size={14} stroke={1.5} />} onClick={handleTosViolation}>
            Remove as TOS Violation
          </Menu.Item>
        )}
        {(!user || !isOwner) && (
          <LoginRedirect reason="report-model">
            <Menu.Item
              leftSection={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openReportModal({ entityType: ReportEntity.Comment, entityId: comment.id })
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

type Props = MenuProps & {
  comment: Pick<CommentGetAllItem, 'id' | 'user' | 'locked' | 'hidden' | 'modelId'>;
  size?: MantineSpacing;
  hideLockOption?: boolean;
};
