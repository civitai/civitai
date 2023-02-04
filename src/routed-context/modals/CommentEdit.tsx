import { Button, Group, Modal, Stack, LoadingOverlay } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { Form, InputRTE, useForm } from '~/libs/form';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { commentUpsertInput } from '~/server/schema/comment.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  schema: z.object({
    commentId: z.number().optional(),
  }),
  Element: ({ context, props: { commentId } }) => {
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
      values.content = values.content.trim();
      if (values.content) saveCommentMutation.mutate(values);
      else context.close();
    };

    const handleClose = () => {
      form.reset({ modelId, content: undefined });
      context.close();
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
        opened={context.opened}
        onClose={!mutating ? context.close : () => ({})}
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
  },
});
