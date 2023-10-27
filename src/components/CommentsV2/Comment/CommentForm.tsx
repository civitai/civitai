import { Stack, Group, Button, Alert, Center, createStyles } from '@mantine/core';
import { Form, InputRTE, useForm } from '~/libs/form';
import { useRef, useState, useMemo } from 'react';
import { UpsertCommentV2Input, upsertCommentv2Schema } from '~/server/schema/commentv2.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import produce from 'immer';
import { EditorCommandsRef } from '~/components/RichTextEditor/RichTextEditor';
import { SimpleUser } from '~/server/selectors/user.selector';
import { IconLock } from '@tabler/icons-react';
import { useCommentsContext, useNewCommentStore } from '~/components/CommentsV2/CommentsProvider';
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
}: {
  comment?: { id: number; content: string };
  onCancel?: () => void;
  autoFocus?: boolean;
  replyTo?: SimpleUser;
}) => {
  const { classes } = useStyles();
  const { entityId, entityType, isMuted, data } = useCommentsContext();
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

  const queryUtils = trpc.useContext();
  const { mutate, isLoading } = trpc.commentv2.upsert.useMutation({
    async onSuccess(response, request) {
      // if it has an id, just set the data with state
      if (request.id) {
        queryUtils.commentv2.getThreadDetails.setData(
          { entityType, entityId },
          produce((old) => {
            if (!old) return;
            const item = old.comments.find((x) => x.id === request.id);
            if (!item) {
              store.editComment(entityType, entityId, response);
            } else {
              item.content = request.content;
            }
          })
        );
      } else {
        queryUtils.commentv2.getCount.setData({ entityType, entityId }, (old = 0) => old + 1);
        store.addComment(entityType, entityId, response);
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
    mutate({ ...comment, ...data, entityId, entityType });
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
            content: classes.content,
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

    '.ProseMirror': {
      padding: 10,
      minHeight: 22,
      cursor: 'text',
    },
  },
}));
