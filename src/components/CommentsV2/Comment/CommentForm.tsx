import { Alert, Button, Center, Group, Stack } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useMemo, useRef, useState } from 'react';
import {
  useCommentsContext,
  useNewCommentStore,
  useRootThreadContext,
} from '~/components/CommentsV2/CommentsProvider';
import type { EditorCommandsRef } from '~/components/RichTextEditor/RichTextEditorComponent';
import { StickerPicker } from '~/components/Sticker/StickerPicker';
import { Form, InputRTE, useForm } from '~/libs/form';
import type { UpsertCommentV2Input } from '~/server/schema/commentv2.schema';
import { upsertCommentv2Schema } from '~/server/schema/commentv2.schema';
import type { SimpleUser } from '~/server/selectors/user.selector';
import { removeDuplicates } from '~/utils/array-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';
import { getQueryKey } from '@trpc/react-query';
import { editCommentInInfiniteCaches } from '~/components/CommentsV2/comment-edit-cache';
import classes from './CommentForm.module.scss';
import clsx from 'clsx';

/*
  Most use cases of this form will require cancel/submit buttons to be displayed
    - divergences:
      - create message
        - show rte, hide cancel/submit buttons until rte focused
*/

const { comments, ...store } = useNewCommentStore.getState();

export const CommentForm = ({
  comment,
  onCancel,
  autoFocus,
  replyTo,
  replyToCommentId,
  borderless,
}: {
  comment?: { id: number; content: string };
  onCancel?: () => void;
  autoFocus?: boolean;
  replyTo?: SimpleUser;
  replyToCommentId?: number;
  borderless?: boolean;
}) => {
  const { setExpanded } = useRootThreadContext();
  const {
    entityId: contextEntityId,
    entityType: contextEntityType,
    isMuted,
    data,
    parentThreadId,
  } = useCommentsContext();

  const entityId = replyToCommentId ? replyToCommentId : contextEntityId;
  const entityType = replyToCommentId ? 'comment' : contextEntityType;

  const editorRef = useRef<EditorCommandsRef | null>(null);
  const [focused, setFocused] = useState(autoFocus);
  const defaultValues = { ...comment, entityId, entityType };
  if (replyTo && replyTo.username)
    defaultValues.content = `<span data-type="mention" data-id="mention:${replyTo.id}" data-label="${replyTo.username}" contenteditable="false">@${replyTo.username}</span>&nbsp;`;
  const form = useForm({
    schema: upsertCommentv2Schema,
    defaultValues,
    shouldUnregister: false,
    mode: 'onBlur',
  });

  const suggestedMentions = useMemo(
    () =>
      removeDuplicates(
        data?.map((comment) => ({
          id: comment.user.id,
          label: comment.user.username as string,
        })) ?? [],
        'id'
      ),
    [data]
  );

  const queryUtils = trpc.useUtils();
  const { mutate, isPending: isLoading } = trpc.commentv2.upsert.useMutation({
    async onSuccess(response, request) {
      // An edit resets to the saved text: the editor now re-syncs on reset, and the original
      // content would show again until the form closes.
      form.reset(request.id ? { ...defaultValues, content: response.content } : undefined);
      // Placements just spent uses, so the picker's counts are stale.
      await queryUtils.cosmetic.getStickerBalances.invalidate();
      // if it has an id, just set the data with state
      if (request.id) {
        // Response is minimally different but key components remain the same so any is used.
        queryUtils.commentv2.getSingle.setData({ id: request.id }, response);
        editCommentInInfiniteCaches(queryClient, getQueryKey(trpc.commentv2.getInfinite), {
          id: request.id,
          content: response.content,
        });
        // Comments created this session render from the store, not the query cache.
        store.editComment(entityType, entityId, response);
      } else {
        const hasThreadData = queryUtils.commentv2.getInfinite.getInfiniteData({
          entityType,
          entityId,
        });

        // If we don't have thread data, child comments will not get a proper parent
        // and convos will be lost.
        if (!hasThreadData) {
          await queryUtils.commentv2.getInfinite.invalidate({
            entityType,
            entityId,
          });
        }

        queryUtils.commentv2.getCount.setData({ entityType, entityId }, (old = 0) => old + 1);
        store.addComment(entityType, entityId, response);
      }

      if (replyToCommentId) setExpanded(replyToCommentId, true);
      // update comment count
      handleCancel();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not save comment',
      });
    },
  });

  const handleCancel = () => {
    if (!autoFocus) setFocused(false);
    onCancel?.();
    form.reset();
  };

  const handleSubmit = (data: UpsertCommentV2Input) => {
    mutate({
      ...comment,
      ...data,
      entityId,
      entityType,
      parentThreadId: replyToCommentId ? parentThreadId : undefined,
    });
  };

  if (isMuted)
    return (
      <Alert color="yellow" icon={<IconLock />}>
        <Center>You cannot add comments because you have been muted</Center>
      </Alert>
    );

  return (
    <Form form={form} onSubmit={handleSubmit} style={{ flex: 1 }}>
      <Stack>
        <InputRTE
          innerRef={editorRef}
          name="content"
          disabled={isLoading}
          includeControls={['formatting', 'link', 'mentions', 'sticker']}
          defaultSuggestions={suggestedMentions}
          placeholder={
            !data?.length ? 'Be the first to leave a comment...' : 'Type your comment...'
          }
          autoFocus={focused}
          onFocus={!autoFocus ? () => setFocused(true) : undefined}
          onSuperEnter={() => form.handleSubmit(handleSubmit)()}
          classNames={{
            root: clsx('overflow-hidden rounded-3xl', borderless && 'border-none'),
            content: clsx(classes.content, 'rounded-3xl'),
          }}
          data-testid="comment-form"
          inputClasses="break-words"
          hideToolbar
        />
        {focused && (
          <Group justify="space-between">
            {/* This composer hides the toolbar, so the picker can't ride in it
                the way it does on surfaces that show one. */}
            <StickerPicker
              position="top-start"
              onSelect={(sticker) => {
                editorRef.current?.insertSticker({ id: sticker.id, slug: sticker.slug });
                // Clears a "Cannot be empty" left over from an earlier blur:
                // pre-submit, mode 'onBlur' won't re-validate on change alone.
                void form.trigger('content');
              }}
            />
            <Group gap="xs">
              <Button variant="default" size="xs" onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="xs"
                loading={isLoading}
                disabled={!form.formState.isDirty}
              >
                Comment
              </Button>
            </Group>
          </Group>
        )}
      </Stack>
    </Form>
  );
};
