import { Button, Group, Stack } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';

import { Form, InputTextArea, useForm } from '~/libs/form';
import { commentUpsertInput } from '~/server/schema/comment.schema';
import { CommentGetAllItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function CommentEditModal({ context, id, innerProps }: ContextModalProps<Props>) {
  const { comment } = innerProps;

  const form = useForm({
    schema: commentUpsertInput,
    defaultValues: { ...comment },
    shouldUnregister: false,
    shouldFocusError: true,
  });
  const queryUtils = trpc.useContext();

  const saveCommentMutation = trpc.comment.upsert.useMutation({
    async onSuccess() {
      await queryUtils.comment.getAll.invalidate();
      handleClose();
    },
    onError: (error) => {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not save the comment',
        reason: `There was an error when trying to save your comment. Please try again`,
      });
    },
  });

  const handleClose = () => {
    form.reset();
    context.closeModal(id);
  };

  return (
    <Form form={form} onSubmit={(data) => saveCommentMutation.mutate(data)}>
      <Stack spacing="md">
        <InputTextArea name="content" minRows={3} placeholder="Type your thoughts..." autosize />
        <Group position="apart">
          <Button variant="default" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saveCommentMutation.isLoading}>
            {comment.id ? 'Save' : 'Comment'}
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

type Props = {
  comment: CommentGetAllItem;
};
