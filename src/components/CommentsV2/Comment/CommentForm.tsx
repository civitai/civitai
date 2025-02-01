import { Stack, Group, Button, Alert, Center, createStyles } from '@mantine/core';
import { Form, InputRTE, useForm } from '~/libs/form';
import { useRef, useState, useMemo } from 'react';
import { UpsertCommentV2Input, upsertCommentv2Schema } from '~/server/schema/commentv2.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import produce from 'immer';
import type { EditorCommandsRef } from '~/components/RichTextEditor/RichTextEditorComponent';
import { SimpleUser } from '~/server/selectors/user.selector';
import { IconLock } from '@tabler/icons-react';
import {
  useCommentsContext,
  useNewCommentStore,
  useRootThreadContext,
} from '~/components/CommentsV2/CommentsProvider';
import { removeDuplicates } from '~/utils/array-helpers';

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
  const { classes, cx } = useStyles();
  const { expanded, toggleExpanded } = useRootThreadContext();
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
  if (replyTo)
    defaultValues.content = `<span data-type="mention" data-id="mention:${replyTo.id}" data-label="${replyTo.username}" contenteditable="false">@${replyTo.username}</span>&nbsp;`;
  const form = useForm({
    schema: upsertCommentv2Schema,
    defaultValues,
    shouldUnregister: false,
    mode: 'onChange',
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
  const { mutate, isLoading } = trpc.commentv2.upsert.useMutation({
    async onSuccess(response, request) {
      // if it has an id, just set the data with state
      if (request.id) {
        // Response is minimally different but key components remain the same so any is used.
        queryUtils.commentv2.getSingle.setData({ id: request.id }, response);
        queryUtils.commentv2.getThreadDetails.setData(
          { entityType, entityId },
          produce((old) => {
            if (!old) {
              return;
            }
            const item = old.comments?.find((x) => x.id === request.id);
            if (!item) {
              store.editComment(entityType, entityId, response);
            } else {
              item.content = request.content as string;
            }
          })
        );
      } else {
        const hasThreadData = queryUtils.commentv2.getThreadDetails.getData({
          entityType,
          entityId,
        });

        // If we don't have thread data, child comments will not get a proper parent
        // and convos will be lost.
        if (!hasThreadData) {
          await queryUtils.commentv2.getThreadDetails.invalidate({
            entityType,
            entityId,
          });
        }

        queryUtils.commentv2.getCount.setData({ entityType, entityId }, (old = 0) => old + 1);
        store.addComment(entityType, entityId, response);
      }

      if (replyToCommentId && !expanded.includes(replyToCommentId)) {
        toggleExpanded(replyToCommentId);
      }
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
          includeControls={['formatting', 'link', 'mentions']}
          defaultSuggestions={suggestedMentions}
          hideToolbar
          placeholder={
            !data?.length ? 'Be the first to leave a comment...' : 'Type your comment...'
          }
          autoFocus={focused}
          onFocus={!autoFocus ? () => setFocused(true) : undefined}
          onSuperEnter={() => form.handleSubmit(handleSubmit)()}
          classNames={{
            root: borderless ? 'border-none' : undefined,
            content: cx(classes.content, 'rounded-3xl'),
          }}
        />
        {focused && (
          <Group position="right">
            <Button variant="default" size="xs" onClick={handleCancel}>
              Cancel
            </Button>
            <Button type="submit" size="xs" loading={isLoading} disabled={!form.formState.isDirty}>
              Comment
            </Button>
          </Group>
        )}
      </Stack>
    </Form>
  );
};

const useStyles = createStyles((theme) => ({
  content: {
    padding: 0,
    fontSize: 14,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],

    '.ProseMirror': {
      padding: `8px 12px`,
      minHeight: 38,
      cursor: 'text',
    },
  },
}));
