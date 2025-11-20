import { Badge, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArrowBackUp,
  IconDotsVertical,
  IconEdit,
  IconFlag,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import type { ReactionDetails } from '~/server/selectors/reaction.selector';
import type { CommentGetCommentsById } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function CommentSectionItem({ comment, modelId, onReplyClick }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
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
      await queryUtils.comment.getCommentsCount.cancel();
      const { parentId } = comment;

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
      await queryUtils.comment.getCommentsById.invalidate();
    },
    onError(error, _variables, context) {
      const { parentId } = comment;

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
            profilePicture: null, // not really necessary for reactions
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
    <Group align="flex-start" justify="space-between" wrap="nowrap">
      <Group align="flex-start" style={{ flex: '1 1 0' }} wrap="nowrap">
        <UserAvatar user={comment.user} size="md" linkToProfile />
        <Stack gap="xs" style={{ flex: '1 1 0' }}>
          <Stack gap={0}>
            <Group gap={8} align="center">
              {!comment.user.deletedAt ? (
                <Text component={Link} href={`/user/${comment.user.username}`} size="sm" fw="bold">
                  <Username {...comment.user} />
                </Text>
              ) : (
                <Username {...comment.user} />
              )}
              {comment.user.id === model?.user.id ? (
                <Badge color="violet" size="xs">
                  OP
                </Badge>
              ) : null}
              <Text c="dimmed" className="text-xs" component="a" href={directLink.toString()}>
                <DaysFromNow date={comment.createdAt} />
              </Text>
            </Group>
            {!isEditing ? (
              <RenderHtml
                html={comment.content}
                className="text-sm"
                withMentions
                withProfanityFilter
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
                // withLinkValidation
              />
            )}
          </Stack>
          {!isEditing ? (
            <Group gap={4}>
              <ReactionPicker
                reactions={reactions}
                onSelect={(reaction) => toggleReactionMutation.mutate({ id: comment.id, reaction })}
              />
              {currentUser && !isOwner && !comment.locked && !isMuted && (
                <Button
                  variant="subtle"
                  radius="xl"
                  onClick={() => onReplyClick(comment)}
                  size="compact-xs"
                >
                  <Group gap={4}>
                    <IconArrowBackUp size={14} />
                    Reply
                  </Group>
                </Button>
              )}
            </Group>
          ) : (
            <Group justify="flex-end">
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
            <LegacyActionIcon size="xs" variant="subtle">
              <IconDotsVertical size={14} />
            </LegacyActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {isOwner || isMod ? (
              <>
                <Menu.Item
                  leftSection={<IconTrash size={14} stroke={1.5} />}
                  onClick={() => handleDeleteComment(comment.id)}
                  color="red"
                >
                  Delete comment
                </Menu.Item>
                {((!comment.locked && !isMuted) || isMod) && (
                  <Menu.Item
                    leftSection={<IconEdit size={14} stroke={1.5} />}
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
                  leftSection={<IconFlag size={14} stroke={1.5} />}
                  onClick={() =>
                    openReportModal({
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
