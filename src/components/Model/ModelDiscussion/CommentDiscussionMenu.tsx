import { ActionIcon, MantineNumberSize, Menu, MenuProps, Text } from '@mantine/core';
import { closeAllModals, closeModal, openConfirmModal } from '@mantine/modals';
import {
  IconDotsVertical,
  IconTrash,
  IconEdit,
  IconFlag,
  IconLock,
  IconLockOpen,
  IconBan,
} from '@tabler/icons';
import { SessionUser } from 'next-auth';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { openContext } from '~/providers/CustomModalsProvider';
import { closeRoutedContext, openRoutedContext } from '~/providers/RoutedContextProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { CommentGetAllItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function CommentDiscussionMenu({
  comment,
  user,
  size = 'xs',
  hideLockOption = false,
  ...props
}: Props) {
  const queryUtils = trpc.useContext();

  const isMod = user?.isModerator ?? false;
  const isOwner = comment.user.id === user?.id;
  const isMuted = user?.muted ?? false;

  const deleteMutation = trpc.comment.delete.useMutation({
    async onSuccess() {
      await queryUtils.comment.getAll.invalidate();
      closeAllModals();
      closeRoutedContext();
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
      closeRoutedContext();
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
      children: `Are you sure you want to report this comment for a Terms of Service violation? Once marked, it won't show up for other people`,
      centered: true,
      labels: { confirm: 'Yes', cancel: 'Cancel' },
      confirmProps: { color: 'red', disabled: tosViolationMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => tosViolationMutation.mutate({ id: comment.id }),
    });
  };

  return (
    <Menu position="bottom-end" withinPortal {...props}>
      <Menu.Target>
        <ActionIcon size={size} variant="subtle">
          <IconDotsVertical size={14} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {(isOwner || isMod) && (
          <>
            <Menu.Item
              icon={<IconTrash size={14} stroke={1.5} />}
              color="red"
              onClick={handleDeleteComment}
            >
              Delete comment
            </Menu.Item>
            {((!comment.locked && !isMuted) || isMod) && (
              <Menu.Item
                icon={<IconEdit size={14} stroke={1.5} />}
                onClick={() => openRoutedContext('commentEdit', { commentId: comment.id })}
              >
                Edit comment
              </Menu.Item>
            )}
            {isMod && !hideLockOption && (
              <Menu.Item
                icon={
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
            {isMod && (
              <Menu.Item icon={<IconBan size={14} stroke={1.5} />} onClick={handleTosViolation}>
                Remove as TOS Violation
              </Menu.Item>
            )}
          </>
        )}
        {(!user || !isOwner) && (
          <LoginRedirect reason="report-model">
            <Menu.Item
              icon={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openContext('report', { entityType: ReportEntity.Comment, entityId: comment.id })
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
  comment: Pick<CommentGetAllItem, 'id' | 'user' | 'locked'>;
  user?: SessionUser | null;
  size?: MantineNumberSize;
  hideLockOption?: boolean;
};
