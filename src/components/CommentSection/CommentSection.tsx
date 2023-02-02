import {
  Alert,
  Box,
  Button,
  Center,
  createStyles,
  Group,
  List,
  Overlay,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { closeAllModals } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { IconLock } from '@tabler/icons';
import { useRouter } from 'next/router';
import { useRef, useState } from 'react';
import { z } from 'zod';

import { CommentSectionItem } from '~/components/CommentSection/CommentSectionItem';
import { EditorCommandsRef } from '~/components/RichTextEditor/RichTextEditor';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputRTE, useForm } from '~/libs/form';
import { commentUpsertInput } from '~/server/schema/comment.schema';
import {
  CommentGetById,
  CommentGetCommentsById,
  ReviewGetById,
  ReviewGetCommentsById,
} from '~/types/router';
import { removeDuplicates } from '~/utils/array-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function CommentSection({ comments, modelId, review, parent, highlights }: Props) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const theme = useMantineTheme();
  const queryUtils = trpc.useContext();
  const { classes } = useStyles();
  highlights = highlights?.filter((x) => x);

  const editorRef = useRef<EditorCommandsRef | null>(null);

  const reviewId = review?.id;
  const parentId = parent?.id;
  const form = useForm({
    schema: commentUpsertInput,
    shouldUnregister: false,
    defaultValues: { modelId, reviewId, parentId },
  });

  const [showCommentActions, setShowCommentActions] = useState(false);

  const saveCommentMutation = trpc.comment.upsert.useMutation({
    async onMutate() {
      await queryUtils.review.getCommentsCount.cancel();
      await queryUtils.comment.getCommentsCount.cancel();

      if (reviewId) {
        const prevCount = queryUtils.review.getCommentsCount.getData({ id: reviewId }) ?? 0;
        queryUtils.review.getCommentsCount.setData({ id: reviewId }, (old = 0) => old + 1);

        return { prevCount };
      }

      if (parentId) {
        const prevCount = queryUtils.comment.getCommentsCount.getData({ id: parentId }) ?? 0;
        queryUtils.comment.getCommentsCount.setData({ id: parentId }, (old = 0) => old + 1);

        return { prevCount };
      }

      return {};
    },
    async onSuccess() {
      await queryUtils.review.getCommentsById.invalidate();
      await queryUtils.comment.getCommentsById.invalidate();

      setShowCommentActions(false);
      form.reset();
    },
    onError(error, _variables, context) {
      if (reviewId)
        queryUtils.review.getCommentsCount.setData({ id: reviewId }, context?.prevCount);
      if (parentId)
        queryUtils.comment.getCommentsCount.setData({ id: parentId }, context?.prevCount);

      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not save comment',
      });
    },
  });

  const isMuted = currentUser?.muted ?? false;
  const mainComment = review ?? parent;
  const commentCount = comments.length;
  const suggestedMentions = removeDuplicates(
    [...comments, mainComment]
      .filter((comment) => comment && comment.user.id !== currentUser?.id)
      .map((comment) => ({
        id: comment?.user.id as number,
        label: comment?.user.username as string,
      })),
    'id'
  ).slice(0, 5);

  const handleSubmitComment = (data: z.infer<typeof commentUpsertInput>) =>
    saveCommentMutation.mutate({ ...data });

  return (
    <Stack spacing="xl">
      <Group position="apart">
        <Title order={3}>{`${commentCount.toLocaleString()} ${
          commentCount === 1 ? 'Comment' : 'Comments'
        }`}</Title>
      </Group>
      {!mainComment?.locked && !isMuted ? (
        <Group align="flex-start">
          <UserAvatar user={currentUser} avatarProps={{ size: 'md' }} />
          <Form form={form} onSubmit={handleSubmitComment} style={{ flex: '1 1 0' }}>
            <Stack spacing="xs">
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

                <InputRTE
                  name="content"
                  placeholder="Type your comment..."
                  includeControls={['formatting', 'link', 'mentions']}
                  disabled={saveCommentMutation.isLoading}
                  onFocus={() => setShowCommentActions(true)}
                  defaultSuggestions={suggestedMentions}
                  autoFocus={showCommentActions}
                  innerRef={editorRef}
                  onSuperEnter={() => form.handleSubmit(handleSubmitComment)()}
                  hideToolbar
                />
              </Box>
              {showCommentActions ? (
                <Group spacing="xs" position="right">
                  <Button
                    variant="default"
                    onClick={() => {
                      setShowCommentActions(false);
                      form.reset();
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
      ) : (
        <Alert color="yellow" icon={<IconLock />}>
          <Center>
            {isMuted
              ? 'You cannot add comments because you have been muted'
              : 'This thread has been locked'}
          </Center>
        </Alert>
      )}
      <List listStyleType="none" spacing="lg" styles={{ itemWrapper: { width: '100%' } }}>
        {comments.map((comment) => {
          const isHighlighted = highlights?.includes(comment.id);

          return (
            <List.Item
              key={comment.id}
              className={isHighlighted ? classes.highlightedComment : undefined}
            >
              <CommentSectionItem
                comment={comment}
                modelId={modelId}
                onReplyClick={(comment) => {
                  setShowCommentActions(true);
                  editorRef.current?.insertContentAtCursor(
                    `<span data-type="mention" data-id="mention:${comment.user.id}" data-label="${comment.user.username}" contenteditable="false">@${comment.user.username}</span>&nbsp;`
                  );
                }}
              />
            </List.Item>
          );
        })}
      </List>
    </Stack>
  );
}

type Props = {
  comments: ReviewGetCommentsById | CommentGetCommentsById;
  modelId: number;
  review?: ReviewGetById;
  parent?: CommentGetById;
  highlights?: number[];
};

const useStyles = createStyles((theme) => ({
  highlightedComment: {
    background: theme.fn.rgba(theme.colors.blue[5], 0.2),
    margin: `-${theme.spacing.xs}px`,
    padding: `${theme.spacing.xs}px`,
  },
}));
