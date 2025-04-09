import { Button, Group, LoadingOverlay, Modal, Stack } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { Form, InputRTE, useForm } from '~/libs/form';
import { commentUpsertInput } from '~/server/schema/comment.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function CommentEditModal({ commentId }: { commentId?: number }) {
  const dialog = useDialogContext();

  const router = useRouter();
  const [value, , removeValue] = useLocalStorage<string | undefined>({
    key: 'commentContent',
    defaultValue: undefined,
  });
  const modelId = Number(router.query.id);
  const [initialContent, setInitialContent] = useState(value);

  const queryUtils = trpc.useContext();
  const { data, isLoading, isFetching } = trpc.comment.getById.useQuery(
    { id: commentId ?? 0 },
    { enabled: !!commentId, keepPreviousData: false }
  );

  const loadingComment = (isLoading || isFetching) && !!commentId;

  const form = useForm({
    schema: commentUpsertInput,
    defaultValues: { modelId, content: initialContent ?? '' },
    shouldUnregister: false,
  });

  const { isDirty, isSubmitted } = form.formState;
  useCatchNavigation({ unsavedChanges: isDirty && !isSubmitted });

  const saveCommentMutation = trpc.comment.upsert.useMutation({
    async onSuccess() {
      await queryUtils.comment.getAll.invalidate();
      if (commentId) await queryUtils.comment.getById.invalidate({ id: commentId });
      handleClose();
    },
    onError: (error) => {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not save the comment',
      });
    },
  });
  const handleSaveComment = (values: z.infer<typeof commentUpsertInput>) => {
    values.content = values.content?.trim() ?? '';
    if (values.content) saveCommentMutation.mutate(values);
    else dialog.onClose();
  };

  const handleClose = () => {
    form.reset({ modelId, content: undefined });
    dialog.onClose();
  };

  useEffect(() => {
    if (data && !loadingComment) form.reset(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, loadingComment]);

  useEffect(() => {
    if (!initialContent && value) {
      setInitialContent(value);
      form.reset({ modelId, content: value });
      removeValue();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent, removeValue, value]);

  const mutating = saveCommentMutation.isLoading;

  return (
    <Modal
      opened={dialog.opened}
      onClose={!mutating ? dialog.onClose : () => ({})}
      title={commentId ? 'Editing comment' : 'Add a comment'}
      closeOnClickOutside={!mutating}
      closeOnEscape={!mutating}
    >
      <LoadingOverlay visible={loadingComment} />
      <Form form={form} onSubmit={handleSaveComment}>
        <Stack spacing="md">
          <InputRTE
            name="content"
            placeholder="Type your thoughts..."
            includeControls={['formatting', 'link', 'mentions']}
            editorSize="xl"
            onSuperEnter={() => form.handleSubmit(handleSaveComment)()}
            inputClasses="break-all"
            // withLinkValidation
          />
          <Group position="apart">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saveCommentMutation.isLoading}>
              {!!commentId ? 'Save' : 'Comment'}
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
