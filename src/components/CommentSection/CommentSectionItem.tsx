import { Anchor, Badge, Group, Stack, Text, Button, Menu, ActionIcon } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDotsVertical, IconTrash, IconEdit, IconFlag, IconArrowBackUp } from '@tabler/icons';
import Link from 'next/link';
import { useState } from 'react';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { CommentGetCommentsById } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function CommentSectionItem({ comment, modelId, onReplyClick }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  // TODO Briant: This is a hack to support direct linking to a comment...
  // I wanted to just use a hash, but that broke things on refresh...
  const directLink = new URL(window.location.href);
  directLink.searchParams.set('highlight', comment.id.toString());

  const [editComment, setEditComment] = useState<Props['comment'] | null>(null);

  const { data: reactions = [] } = trpc.comment.getReactions.useQuery(
    { commentId: comment.id },
    { initialData: comment.reactions }
  );
  const { data: model } = trpc.model.getById.useQuery({ id: comment.modelId });

  const saveCommentMutation = trpc.comment.upsert.useMutation({
    async onSuccess() {
      await queryUtils.review.getCommentsById.invalidate();
      await queryUtils.comment.getCommentsById.invalidate();
      setEditComment(null);
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not save comment',
      });
    },
  });

  const deleteMutation = trpc.comment.delete.useMutation({
    async onMutate() {
      await queryUtils.review.getCommentsCount.cancel();
      await queryUtils.comment.getCommentsCount.cancel();
      const { reviewId, parentId } = comment;

      if (reviewId) {
        const prevCount = queryUtils.review.getCommentsCount.getData({ id: reviewId }) ?? 0;
        queryUtils.review.getCommentsCount.setData({ id: reviewId }, (old = 0) =>
          old > 0 ? old - 1 : old
        );

        return { prevCount };
      }

      if (parentId) {
        const prevCount = queryUtils.comment.getCommentsCount.getData({ id: parentId }) ?? 0;
        queryUtils.comment.getCommentsCount.setData({ id: parentId }, (old = 0) =>
          old > 0 ? old - 1 : old
        );

        return { prevCount };
      }

      return {};
    },
    async onSuccess() {
      await queryUtils.review.getCommentsById.invalidate();
      await queryUtils.comment.getCommentsById.invalidate();
    },
    onError(error, _variables, context) {
      const { reviewId, parentId } = comment;

      if (reviewId)
        queryUtils.review.getCommentsCount.setData({ id: reviewId }, context?.prevCount);
      if (parentId)
        queryUtils.comment.getCommentsCount.setData({ id: parentId }, context?.prevCount);

      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete comment',
      });
    },
  });
  const handleDeleteComment = (id: number) => {
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
      onConfirm: () => {
        deleteMutation.mutate({ id });
      },
    });
  };

  const toggleReactionMutation = trpc.comment.toggleReaction.useMutation({
    async onMutate({ id, reaction }) {
      await queryUtils.comment.getReactions.cancel({ commentId: comment.id });

      const previousReactions =
        queryUtils.comment.getReactions.getData({ commentId: comment.id }) ?? [];
      const latestReaction =
        previousReactions.length > 0 ? previousReactions[previousReactions.length - 1] : { id: 0 };

      if (currentUser) {
        const newReaction: ReactionDetails = {
          id: latestReaction.id + 1,
          reaction,
          user: {
            id: currentUser.id,
            deletedAt: null,
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
    onError(_error, _variables, context) {
      queryUtils.comment.getReactions.setData(
        { commentId: comment.id },
        context?.previousReactions
      );
    },
  });

  const isOwner = currentUser?.id === comment.user.id;
  const isMod = currentUser?.isModerator ?? false;
  const isMuted = currentUser?.muted ?? false;
  const isEditing = editComment?.id === comment.id;

  return (
    <Group align="flex-start" position="apart" noWrap>
      <Group align="flex-start" sx={{ flex: '1 1 0' }} noWrap>
        <UserAvatar user={comment.user} size="md" linkToProfile />
        <Stack spacing="xs" sx={{ flex: '1 1 0' }}>
          <Stack spacing={0}>
            <Group spacing={8} align="center">
              {!comment.user.deletedAt ? (
                <Link href={`/user/${comment.user.username}`} passHref>
                  <Anchor variant="text" size="sm" weight="bold">
                    <Username {...comment.user} />
                  </Anchor>
                </Link>
              ) : (
                <Username {...comment.user} />
              )}
              {comment.user.id === model?.user.id ? (
                <Badge color="violet" size="xs">
                  OP
                </Badge>
              ) : null}
              <Text color="dimmed" size="xs" component="a" href={directLink.toString()}>
                <DaysFromNow date={comment.createdAt} />
              </Text>
            </Group>
            {!isEditing ? (
              <RenderHtml
                html={comment.content}
                sx={(theme) => ({ fontSize: theme.fontSizes.sm })}
                withMentions
              />
            ) : (
              <RichTextEditor
                value={editComment.content}
                disabled={saveCommentMutation.isLoading}
                includeControls={['formatting', 'link', 'mentions']}
                onChange={(value) =>
                  setEditComment((state) => (state ? { ...state, content: value } : state))
                }
                hideToolbar
              />
            )}
          </Stack>
          {!isEditing ? (
            <Group spacing={4}>
              <ReactionPicker
                reactions={reactions}
                onSelect={(reaction) => toggleReactionMutation.mutate({ id: comment.id, reaction })}
              />
              {currentUser && !isOwner && !comment.locked && !isMuted && (
                <Button
                  variant="subtle"
                  size="xs"
                  radius="xl"
                  onClick={() => onReplyClick(comment)}
                  compact
                >
                  <Group spacing={4}>
                    <IconArrowBackUp size={14} />
                    Reply
                  </Group>
                </Button>
              )}
            </Group>
          ) : (
            <Group position="right">
              <Button variant="default" size="xs" onClick={() => setEditComment(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => saveCommentMutation.mutate({ ...comment, ...editComment, modelId })}
                size="xs"
                loading={editComment && saveCommentMutation.isLoading}
              >
                Comment
              </Button>
            </Group>
          )}
        </Stack>
      </Group>
      {!isEditing && (
        <Menu position="bottom-end">
          <Menu.Target>
            <ActionIcon size="xs" variant="subtle">
              <IconDotsVertical size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {isOwner || isMod ? (
              <>
                <Menu.Item
                  icon={<IconTrash size={14} stroke={1.5} />}
                  onClick={() => handleDeleteComment(comment.id)}
                  color="red"
                >
                  Delete comment
                </Menu.Item>
                {((!comment.locked && !isMuted) || isMod) && (
                  <Menu.Item
                    icon={<IconEdit size={14} stroke={1.5} />}
                    onClick={() => setEditComment(comment)}
                  >
                    Edit comment
                  </Menu.Item>
                )}
              </>
            ) : null}
            {(!currentUser || !isOwner) && (
              <LoginRedirect reason="report-model">
                <Menu.Item
                  icon={<IconFlag size={14} stroke={1.5} />}
                  onClick={() =>
                    openContext('report', {
                      entityType: ReportEntity.Comment,
                      entityId: comment.id,
                    })
                  }
                >
                  Report
                </Menu.Item>
              </LoginRedirect>
            )}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}

type Props = {
  comment: CommentGetCommentsById[number];
  modelId: number;
  onReplyClick: (comment: CommentGetCommentsById[number]) => void;
};
