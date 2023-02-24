import {
  GroupProps,
  Group,
  ActionIcon,
  Menu,
  Stack,
  Text,
  Button,
  Box,
  Badge,
} from '@mantine/core';
import { useMemo, useState } from 'react';
import { useCommentsContext } from './CommentsProvider';
import { CreateComment } from './CreateComment';
import { CommentForm } from './CommentForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { IconDotsVertical, IconTrash, IconEdit, IconFlag, IconArrowBackUp } from '@tabler/icons';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { create } from 'zustand';
import { Reactions, ReactionMetrics } from '~/components/Reaction/Reactions';
import { ReviewReactions } from '@prisma/client';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import React from 'react';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Store = {
  id?: number;
  setId: (id?: number) => void;
};

const useStore = create<Store>((set) => ({
  setId: (id) => set(() => ({ id })),
}));

type CommentProps = Omit<GroupProps, 'children'> & {
  comment: InfiniteCommentResults['comments'][0];
};

export function Comment({ comment, ...groupProps }: CommentProps) {
  const { entityId, entityType, isLocked, isMuted, badges } = useCommentsContext();
  const currentUser = useCurrentUser();
  const id = useStore((state) => state.id);
  const setId = useStore((state) => state.setId);
  const isOwner = currentUser?.id === comment.user.id;
  const isMod = currentUser?.isModerator ?? false;
  const editing = id === comment.id;
  const [replying, setReplying] = useState(false);

  const canDelete = isOwner || currentUser?.isModerator;
  const canEdit = (!isLocked && !isMuted) || isMod;
  const canReply = currentUser && !isOwner && !isLocked && !isMuted;
  const badge = badges?.find((x) => x.userId === comment.user.id);

  return (
    <Group align="flex-start" noWrap {...groupProps} spacing="sm">
      <UserAvatar user={comment.user} size="md" linkToProfile />
      <Stack spacing={0} style={{ flex: 1 }}>
        <Group position="apart">
          {/* AVATAR */}
          <Group spacing={8} align="center">
            <UserAvatar
              user={comment.user}
              size="md"
              linkToProfile
              includeAvatar={false}
              withUsername
              badge={
                badge ? (
                  <Badge size="xs" color={badge.color}>
                    {badge.label}
                  </Badge>
                ) : null
              }
            />
            <Text color="dimmed" size="xs" mt={2}>
              <DaysFromNow date={comment.createdAt} />
            </Text>
          </Group>
          {/* CONTROLS */}
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon size="xs" variant="subtle">
                <IconDotsVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {canDelete && (
                <>
                  <DeleteComment id={comment.id} entityId={entityId} entityType={entityType}>
                    <Menu.Item icon={<IconTrash size={14} stroke={1.5} />} color="red">
                      Delete comment
                    </Menu.Item>
                  </DeleteComment>
                  {canEdit && (
                    <Menu.Item
                      icon={<IconEdit size={14} stroke={1.5} />}
                      onClick={() => setId(comment.id)}
                    >
                      Edit comment
                    </Menu.Item>
                  )}
                </>
              )}
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
        </Group>
        {/* COMMENT / EDIT COMMENT */}
        <Stack style={{ flex: 1 }} spacing={4}>
          {!editing ? (
            <>
              <RenderHtml
                html={comment.content}
                sx={(theme) => ({ fontSize: theme.fontSizes.sm })}
              />
              {/* COMMENT INTERACTION */}
              <Group spacing={4}>
                <CommentReactions comment={comment} />
                {canReply && (
                  <Button
                    variant="subtle"
                    size="xs"
                    radius="xl"
                    onClick={() => setReplying(true)}
                    compact
                  >
                    <Group spacing={4}>
                      <IconArrowBackUp size={14} />
                      Reply
                    </Group>
                  </Button>
                )}
              </Group>
            </>
          ) : (
            <CommentForm comment={comment} onCancel={() => setId(undefined)} autoFocus />
          )}
        </Stack>
        {canReply && replying && (
          <Box pt="sm">
            <CreateComment autoFocus replyTo={comment.user} onCancel={() => setReplying(false)} />
          </Box>
        )}
      </Stack>
    </Group>
  );
}

function CommentReactions({ comment }: { comment: InfiniteCommentResults['comments'][0] }) {
  const currentUser = useCurrentUser();
  const userReactions = comment.reactions.filter((x) => x.user.id === currentUser?.id);
  const metrics = useMemo(
    (): ReactionMetrics => ({
      likeCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Like).length,
      dislikeCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Dislike).length,
      heartCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Heart).length,
      laughCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Laugh).length,
      cryCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Cry).length,
    }),
    [comment.reactions]
  );

  return (
    <Reactions
      reactions={userReactions}
      entityId={comment.id}
      entityType="comment"
      metrics={metrics}
    />
  );
}

export function DeleteComment({
  children,
  id,
  entityId,
  entityType,
}: { children: React.ReactElement; id: number } & CommentConnectorInput) {
  const queryUtils = trpc.useContext();
  const { created, setCreated } = useCommentsContext();
  const { mutate, isLoading } = trpc.commentv2.delete.useMutation({
    async onSuccess(response, request) {
      showSuccessNotification({
        title: 'Your comment has been deleted',
        message: 'Successfully deleted the comment',
      });
      if (created.some((x) => x.id === request.id)) {
        setCreated((state) => state.filter((x) => x.id !== request.id));
      } else {
        //TODO.comments - possiby add optimistic updates
        await queryUtils.commentv2.getInfinite.invalidate({ entityId, entityType });
      }
      queryUtils.commentv2.getCount.setData({ entityId, entityType }, (old = 1) => old - 1);
      closeAllModals();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete comment',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });

  const handleDeleteComment = () => {
    openConfirmModal({
      title: 'Delete comment',
      children: <Text size="sm">Are you sure you want to delete this comment?</Text>,
      centered: true,
      labels: { confirm: 'Delete comment', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: isLoading },
      closeOnConfirm: false,
      onConfirm: () => mutate({ id }),
    });
  };

  return React.cloneElement(children, { onClick: handleDeleteComment });
}
