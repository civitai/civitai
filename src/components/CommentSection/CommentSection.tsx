import {
  ActionIcon,
  Box,
  Button,
  Group,
  List,
  Menu,
  Overlay,
  Stack,
  Text,
  Textarea,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { showNotification, hideNotification } from '@mantine/notifications';
import { ReportReason } from '@prisma/client';
import { IconDotsVertical, IconTrash, IconEdit, IconFlag } from '@tabler/icons';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { Form, InputTextArea, useForm } from '~/libs/form';

import { commentUpsertInput } from '~/server/schema/comment.schema';
import { ReactionDetails } from '~/server/selectors/review.selector';
import { CommentGetById, ReviewGetById } from '~/types/router';
import { daysFromNow } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function CommentSection({ comments, modelId, reviewId, parentId }: Props) {
  const { data: session } = useSession();
  const router = useRouter();
  const theme = useMantineTheme();
  const queryUtils = trpc.useContext();
  const form = useForm({
    schema: commentUpsertInput,
    shouldUnregister: false,
    defaultValues: { modelId, reviewId, parentId },
    shouldFocusError: true,
  });

  const [showCommentActions, setShowCommentActions] = useState(false);
  const [editComment, setEditComment] = useState<{ id: number; content: string } | null>(null);

  const saveCommentMutation = trpc.comment.upsert.useMutation({
    async onSuccess() {
      if (reviewId) await queryUtils.review.getReviewComments.invalidate({ id: reviewId });
      if (parentId) await queryUtils.comment.getById.invalidate({ id: parentId });

      await queryUtils.review.getAll.invalidate({ modelId });
      await queryUtils.comment.getAll.invalidate({ modelId });

      setShowCommentActions(false);
      setEditComment(null);
      form.reset();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not save comment',
      });
    },
  });
  const deleteMutation = trpc.comment.delete.useMutation({
    async onSuccess() {
      if (reviewId) await queryUtils.review.getReviewComments.invalidate({ id: reviewId });
      if (parentId) await queryUtils.comment.getById.invalidate({ id: parentId });

      await queryUtils.review.getAll.invalidate({ modelId });
      await queryUtils.comment.getAll.invalidate({ modelId });
    },
    onError(error) {
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

  const reportMutation = trpc.comment.report.useMutation({
    onMutate() {
      showNotification({
        id: 'sending-comment-report',
        loading: true,
        disallowClose: true,
        autoClose: false,
        message: 'Sending report...',
      });
    },
    async onSuccess() {
      if (reviewId) await queryUtils.review.getReviewComments.invalidate({ id: reviewId });
      if (parentId) await queryUtils.comment.getById.invalidate({ id: parentId });
      showSuccessNotification({
        title: 'Comment reported',
        message: 'Your request has been received',
      });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to send report',
        reason: 'An unexpected error occurred, please try again',
      });
    },
    onSettled() {
      hideNotification('sending-comment-report');
    },
  });
  const handleReportComment = (id: number, reason: ReportReason) => {
    reportMutation.mutate({ id, reason });
  };

  const toggleReactionMutation = trpc.comment.toggleReaction.useMutation({
    async onMutate({ id, reaction }) {
      const itemId = reviewId ?? parentId ?? 0;
      const cachedQuery = reviewId
        ? queryUtils.review.getReviewComments
        : queryUtils.comment.getById;

      await cachedQuery.cancel({ id: itemId });

      const previousItem = cachedQuery.getData({ id: itemId });
      const updatedComments =
        previousItem?.comments.map((comment) => {
          if (comment.id === id) {
            const { reactions } = comment;
            const latestReaction =
              reactions.length > 0 ? reactions[reactions.length - 1] : { id: 0 };

            const newReaction: ReactionDetails = {
              id: latestReaction.id + 1,
              reaction,
              user: {
                id: currentUser?.id ?? 0,
                name: currentUser?.name ?? '',
                username: currentUser?.username ?? '',
                image: currentUser?.image ?? '',
              },
            };
            const reacted = reactions.find(
              (r) => r.reaction === reaction && r.user.id === currentUser?.id
            );

            return {
              ...comment,
              reactions: reacted
                ? comment.reactions.filter((oldReaction) => oldReaction.id !== reacted.id)
                : [...comment.reactions, newReaction],
            };
          }

          return comment;
        }) ?? [];

      cachedQuery.setData({ id: itemId }, (old) => ({ ...old, comments: updatedComments }));

      return { previousItem };
    },
    onError(_error, _variables, context) {
      if (reviewId)
        queryUtils.review.getReviewComments.setData({ id: reviewId }, context?.previousItem);
      if (parentId) queryUtils.comment.getById.setData({ id: parentId }, context?.previousItem);
    },
    async onSettled() {
      if (reviewId) await queryUtils.review.getReviewComments.invalidate({ id: reviewId });
      if (parentId) await queryUtils.comment.getById.invalidate({ id: parentId });
    },
  });

  const currentUser = session?.user;
  const isMod = currentUser?.isModerator ?? false;
  const commentCount = comments.length;

  return (
    <Stack spacing="xl">
      <Group position="apart">
        <Title order={3}>{`${commentCount.toLocaleString()} ${
          commentCount === 1 ? 'Comment' : 'Comments'
        }`}</Title>
        {/* <Select
          size="xs"
          defaultValue={ReviewSort.Newest}
          icon={<IconArrowsSort size={16} stroke={1.5} />}
          data={Object.values(ReviewSort).map((sort) => ({
            label: startCase(sort),
            value: sort,
          }))}
        /> */}
      </Group>
      <Group align="flex-start">
        <UserAvatar user={session?.user} avatarProps={{ size: 'md' }} />
        <Form
          form={form}
          onSubmit={(data) => saveCommentMutation.mutate({ ...data })}
          style={{ flex: '1 1 0' }}
        >
          <Stack spacing={4}>
            <Box sx={{ position: 'relative' }}>
              {!currentUser ? (
                <Overlay color={theme.fn.rgba(theme.colors.gray[9], 0.6)} opacity={1} zIndex={5}>
                  <Stack align="center" justify="center" spacing={2} sx={{ height: '100%' }}>
                    <Text size="xs" color={theme.colors.gray[4]}>
                      You must be logged in to add a comment
                    </Text>
                    <Button
                      component={NextLink}
                      href={`/login?returnUrl=${router.asPath}`}
                      size="xs"
                      onClick={() => closeAllModals()}
                      compact
                    >
                      Log In
                    </Button>
                  </Stack>
                </Overlay>
              ) : null}
              <InputTextArea
                name="content"
                placeholder="Type your comment..."
                disabled={saveCommentMutation.isLoading}
                onFocus={() => setShowCommentActions(true)}
              />
            </Box>
            {showCommentActions ? (
              <Group spacing="xs" position="right">
                <Button
                  variant="default"
                  onClick={() => {
                    form.reset();
                    setShowCommentActions(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={saveCommentMutation.isLoading}>
                  Comment
                </Button>
              </Group>
            ) : null}
          </Stack>
        </Form>
      </Group>
      <List listStyleType="none" spacing="lg" styles={{ itemWrapper: { width: '100%' } }}>
        {comments.map((comment) => {
          const isEditing = editComment?.id === comment.id;
          const isOwner = currentUser?.id === comment.user.id;

          return (
            <List.Item key={comment.id}>
              <Group align="flex-start" position="apart" noWrap>
                <Group align="flex-start" sx={{ flex: '1 1 0' }} noWrap>
                  <UserAvatar user={comment.user} size="md" />
                  <Stack spacing="xs" sx={{ flex: '1 1 0' }}>
                    <Stack spacing={0}>
                      <Group spacing={8} align="center">
                        <Text size="sm" weight="bold">
                          {comment.user.username}
                        </Text>
                        <Text color="dimmed" size="xs">
                          {daysFromNow(comment.createdAt)}
                        </Text>
                      </Group>
                      {!isEditing ? (
                        <Text size="sm">{comment.content}</Text>
                      ) : (
                        <Textarea
                          value={editComment.content}
                          disabled={editComment && saveCommentMutation.isLoading}
                          onChange={(e) =>
                            setEditComment((state) =>
                              state ? { ...state, content: e.target.value } : state
                            )
                          }
                        />
                      )}
                    </Stack>
                    {!isEditing ? (
                      <ReactionPicker
                        reactions={comment.reactions}
                        onSelect={(reaction) =>
                          toggleReactionMutation.mutate({ id: comment.id, reaction })
                        }
                      />
                    ) : (
                      <Group position="right">
                        <Button variant="default" size="xs" onClick={() => setEditComment(null)}>
                          Cancel
                        </Button>
                        <Button
                          onClick={() =>
                            saveCommentMutation.mutate({ ...comment, ...editComment, modelId })
                          }
                          size="xs"
                          loading={editComment && saveCommentMutation.isLoading}
                        >
                          Comment
                        </Button>
                      </Group>
                    )}
                  </Stack>
                </Group>
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
                        <Menu.Item
                          icon={<IconEdit size={14} stroke={1.5} />}
                          onClick={() => setEditComment(comment)}
                        >
                          Edit comment
                        </Menu.Item>
                      </>
                    ) : null}
                    {!session || !isOwner ? (
                      <>
                        <LoginRedirect reason="report-comment">
                          <Menu.Item
                            icon={<IconFlag size={14} stroke={1.5} />}
                            onClick={() => handleReportComment(comment.id, ReportReason.NSFW)}
                          >
                            Report as NSFW
                          </Menu.Item>
                        </LoginRedirect>
                        <LoginRedirect reason="report-comment">
                          <Menu.Item
                            icon={<IconFlag size={14} stroke={1.5} />}
                            onClick={() =>
                              handleReportComment(comment.id, ReportReason.TOSViolation)
                            }
                          >
                            Report as Terms Violation
                          </Menu.Item>
                        </LoginRedirect>
                      </>
                    ) : null}
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </List.Item>
          );
        })}
      </List>
    </Stack>
  );
}

type Props = {
  comments: ReviewGetById['comments'] | CommentGetById['comments'];
  modelId: number;
  reviewId?: number;
  parentId?: number;
};
