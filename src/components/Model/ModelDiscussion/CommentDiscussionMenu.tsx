import { ActionIcon, MantineNumberSize, Menu, MenuProps, Text } from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { IconDotsVertical, IconTrash, IconEdit, IconFlag } from '@tabler/icons';
import { SessionUser } from 'next-auth';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useRoutedContext } from '~/routed-context/routed-context.provider';
import { ReportEntity } from '~/server/schema/report.schema';
import { CommentGetAllItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function CommentDiscussionMenu({
  comment,
  user,
  size = 'xs',
  replaceNavigation = false,
  ...props
}: Props) {
  const { openContext, closeContext } = useRoutedContext();
  const queryUtils = trpc.useContext();

  const isMod = user?.isModerator ?? false;
  const isOwner = comment.user.id === user?.id;

  const deleteMutation = trpc.comment.delete.useMutation({
    async onSuccess() {
      await queryUtils.comment.getAll.invalidate();
      closeAllModals();
      closeContext();
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
            <Menu.Item
              icon={<IconEdit size={14} stroke={1.5} />}
              onClick={() =>
                openContext(
                  'commentEdit',
                  { commentId: comment.id },
                  { replace: replaceNavigation }
                )
              }
            >
              Edit comment
            </Menu.Item>
          </>
        )}
        {(!user || !isOwner) && (
          <LoginRedirect reason="report-model">
            <Menu.Item
              icon={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openContext(
                  'report',
                  { type: ReportEntity.Comment, entityId: comment.id },
                  { replace: replaceNavigation }
                )
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
  comment: Pick<CommentGetAllItem, 'id' | 'user'>;
  user?: SessionUser | null;
  size?: MantineNumberSize;
  replaceNavigation?: boolean;
};
