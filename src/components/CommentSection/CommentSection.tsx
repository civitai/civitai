import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  List,
  Overlay,
  Stack,
  Text,
  Title,
  useMantineTheme,
  rgba,
} from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useRef, useState } from 'react';
import type * as z from 'zod';
import { CommentSectionItem } from '~/components/CommentSection/CommentSectionItem';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { EditorCommandsRef } from '~/components/RichTextEditor/RichTextEditorComponent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputRTE, useForm } from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { commentUpsertInput } from '~/server/schema/comment.schema';
import type { CommentGetById, CommentGetCommentsById } from '~/types/router';
import { removeDuplicates } from '~/utils/array-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from './CommentSection.module.css';

export function CommentSection({ comments, modelId, parent, highlights }: Props) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const theme = useMantineTheme();
  const queryUtils = trpc.useUtils();
  const features = useFeatureFlags();
  highlights = highlights?.filter((x) => x);

  const editorRef = useRef<EditorCommandsRef | null>(null);

  const parentId = parent?.id;
  const form = useForm({
    schema: commentUpsertInput,
    shouldUnregister: false,
    defaultValues: { modelId, parentId },
  });

  const [showCommentActions, setShowCommentActions] = useState(false);

  const saveCommentMutation = trpc.comment.upsert.useMutation({
    async onMutate() {
      await queryUtils.comment.getCommentsCount.cancel();

      if (parentId) {
        const prevCount = queryUtils.comment.getCommentsCount.getData({ id: parentId }) ?? 0;
        queryUtils.comment.getCommentsCount.setData({ id: parentId }, (old = 0) => old + 1);

        return { prevCount };
      }

      return {};
    },
    async onSuccess() {
      await queryUtils.comment.getCommentsById.invalidate();

      setShowCommentActions(false);
      form.reset();
    },
    onError(error, _variables, context) {
      if (parentId)
        queryUtils.comment.getCommentsCount.setData({ id: parentId }, context?.prevCount);

      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not save comment',
      });
    },
  });

  const isMuted = currentUser?.muted ?? false;
  const mainComment = parent;
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
    <Stack gap="xl">
      <Group justify="space-between">
        <Title order={3}>{`${commentCount.toLocaleString()} ${
          commentCount === 1 ? 'Comment' : 'Comments'
        }`}</Title>
      </Group>
      {features.canWrite && !mainComment?.locked && !isMuted ? (
        <Group align="flex-start">
          <UserAvatar user={currentUser} avatarProps={{ size: 'md' }} />
          <Form form={form} onSubmit={handleSubmitComment} style={{ flex: '1 1 0' }}>
            <Stack gap="xs">
              <Box style={{ position: 'relative' }}>
                {!currentUser ? (
                  <Overlay color={rgba(theme.colors.gray[9], 0.6)} opacity={1} zIndex={5}>
                    <Stack align="center" justify="center" gap={2} style={{ height: '100%' }}>
                      <Text size="xs" c="gray.4">
                        You must be logged in to add a comment
                      </Text>
                      <Link href={`/login?returnUrl=${router.asPath}`}>
                        <Button size="compact-xs" onClick={() => dialogStore.closeLatest()}>
                          Log In
                        </Button>
                      </Link>
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
                  // withLinkValidation
                  inputClasses="break-words"
                />
              </Box>
              {showCommentActions ? (
                <Group gap="xs" justify="flex-end">
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
              : !features.canWrite
              ? 'Civitai is in read-only mode'
              : 'This thread has been locked'}
          </Center>
        </Alert>
      )}
      <List
        listStyleType="none"
        spacing="lg"
        styles={{ itemWrapper: { width: '100%' }, itemLabel: { width: '100%' } }}
      >
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
  comments: CommentGetCommentsById;
  modelId: number;
  parent?: CommentGetById;
  highlights?: number[];
};
