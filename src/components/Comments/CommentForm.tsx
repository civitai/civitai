import { Stack, Group, Button } from '@mantine/core';
import { Form, InputRTE, useForm } from '~/libs/form';
import { useState } from 'react';
import {
  CommentConnectorInput,
  UpsertCommentV2Input,
  upsertCommentv2Schema,
} from '~/server/schema/commentv2.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import produce from 'immer';

/*
  Most use cases of this form will require cancel/submit buttons to be displayed
    - divergences:
      - create message
        - show rte, hide cancel/submit buttons until rte focused
*/

export const CommentForm = ({
  comment,
  onCancel,
  entityId,
  entityType,
  autoFocus,
}: {
  comment?: { id: number; content: string };
  onCancel?: () => void;
  autoFocus?: boolean;
} & CommentConnectorInput) => {
  const [focused, setFocused] = useState(autoFocus);
  const form = useForm({
    schema: upsertCommentv2Schema,
    defaultValues: { ...comment, entityId, entityType },
    shouldUnregister: false,
  });

  const queryUtils = trpc.useContext();
  const { mutate, isLoading } = trpc.commentv2.upsert.useMutation({
    async onSuccess(response, request) {
      // if it has an id, just set the data with state
      if (request.id) {
        queryUtils.commentv2.getInfinite.setInfiniteData(
          { entityId, entityType },
          produce((data) => {
            if (!data) {
              data = {
                pages: [],
                pageParams: [],
              };
            } else {
              let pageIndex = -1;
              let commentIndex = -1;
              data.pages.map((page, pIndex) =>
                page.comments.map((comment, cIndex) => {
                  if (comment.id === request.id) {
                    pageIndex = pIndex;
                    commentIndex = cIndex;
                  }
                })
              );
              if (pageIndex > -1 && commentIndex > -1)
                data.pages[pageIndex].comments[commentIndex].content = request.content;
            }
          })
        );
      } else {
        await queryUtils.commentv2.getInfinite.invalidate({ entityType, entityId });
        queryUtils.commentv2.getCount.setData({ entityType, entityId }, (old = 0) => old + 1);
      }
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

  return (
    <Form form={form} onSubmit={handleSubmit} style={{ flex: 1 }}>
      <Stack>
        <InputRTE
          name="content"
          disabled={isLoading}
          includeControls={['formatting', 'link']}
          hideToolbar
          placeholder="Type your comment..."
          autoFocus={focused}
          onFocus={!autoFocus ? () => setFocused(true) : undefined}
        />
        {focused && (
          <Group position="right">
            <Button variant="default" size="xs" onClick={handleCancel}>
              Cancel
            </Button>
            <Button type="submit" size="xs" loading={isLoading}>
              Comment
            </Button>
          </Group>
        )}
      </Stack>
    </Form>
  );
};
