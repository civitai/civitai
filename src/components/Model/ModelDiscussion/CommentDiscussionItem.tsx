import { ActionIcon, Button, Card, Group, Menu, Text } from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { ReviewReactions } from '@prisma/client';
import { IconDotsVertical, IconTrash, IconEdit, IconFlag, IconMessageCircle2 } from '@tabler/icons';

import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRoutedContext } from '~/routed-context/routed-context.provider';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { ReportEntity } from '~/server/schema/report.schema';
import { CommentGetAllItem } from '~/types/router';
import { daysFromNow } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export function CommentDiscussionItem({ comment }: Props) {
  const { openContext } = useRoutedContext();
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === comment.user.id;
  const isMod = currentUser?.isModerator ?? false;

  const { data: reactions = [] } = trpc.comment.getReactions.useQuery(
    { commentId: comment.id },
    { initialData: comment.reactions }
  );
  const { data: commentCount = 0 } = trpc.comment.getCommentsCount.useQuery(
    { id: comment.id },
    { initialData: comment._count.comments }
  );

  const queryUtils = trpc.useContext();
  const deleteMutation = trpc.comment.delete.useMutation({
    async onSuccess() {
      await queryUtils.comment.getAll.invalidate();
      closeAllModals();
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

  const toggleReactionMutation = trpc.comment.toggleReaction.useMutation({
    async onMutate({ id, reaction }) {
      await queryUtils.comment.getReactions.cancel({ commentId: id });

      const previousReactions = queryUtils.comment.getReactions.getData({ commentId: id }) ?? [];
      const latestReaction =
        previousReactions.length > 0 ? previousReactions[previousReactions.length - 1] : { id: 0 };

      if (currentUser) {
        const newReaction: ReactionDetails = {
          id: latestReaction.id + 1,
          reaction,
          user: {
            id: currentUser.id,
            name: currentUser.name ?? '',
            username: currentUser.username ?? '',
            image: currentUser.image ?? '',
          },
        };
        const reacted = previousReactions.find(
          (r) => r.reaction === reaction && r.user.id === currentUser.id
        );
        queryUtils.comment.getReactions.setData({ commentId: id }, (old = []) =>
          reacted
            ? old.filter((oldReaction) => oldReaction.id !== reacted.id)
            : [...old, newReaction]
        );
      }

      return { previousReactions };
    },
    onError(_error, variables, context) {
      queryUtils.comment.getReactions.setData(
        { commentId: variables.id },
        context?.previousReactions
      );
    },
  });
  const handleReactionClick = (reaction: ReviewReactions) => {
    toggleReactionMutation.mutate({ id: comment.id, reaction });
  };

  return (
    <Card radius="md" p="md" withBorder>
      <Group align="flex-start" sx={{ justifyContent: 'space-between' }} noWrap>
        <UserAvatar user={comment.user} subText={daysFromNow(comment.createdAt)} withUsername />
        <Menu position="bottom-end">
          <Menu.Target>
            <ActionIcon size="xs" variant="subtle">
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
                  onClick={() => openContext('commentEdit', { commentId: comment.id })}
                >
                  Edit comment
                </Menu.Item>
              </>
            )}
            {(!currentUser || !isOwner) && (
              <LoginRedirect reason="report-model">
                <Menu.Item
                  icon={<IconFlag size={14} stroke={1.5} />}
                  onClick={() =>
                    openContext('report', { type: ReportEntity.Comment, entityId: comment.id })
                  }
                >
                  Report
                </Menu.Item>
              </LoginRedirect>
            )}
          </Menu.Dropdown>
        </Menu>
      </Group>

      <ContentClamp maxHeight={100}>
        <RenderHtml html={comment.content} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
      </ContentClamp>

      <Group mt="sm" align="flex-start" position="apart" noWrap>
        <ReactionPicker
          reactions={reactions}
          onSelect={handleReactionClick}
          disabled={toggleReactionMutation.isLoading}
        />
        <Button
          size="xs"
          radius="xl"
          variant="subtle"
          onClick={() => openContext('commentThread', { commentId: comment.id })}
          compact
        >
          <Group spacing={2} noWrap>
            <IconMessageCircle2 size={14} />
            <Text>{abbreviateNumber(commentCount)}</Text>
          </Group>
        </Button>
      </Group>
    </Card>
  );
}

type Props = { comment: CommentGetAllItem };
