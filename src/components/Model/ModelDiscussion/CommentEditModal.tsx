import { Button, Group, Modal, Stack } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import * as z from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { Form, InputRTE, useForm } from '~/libs/form';
import { commentContentSchema } from '~/server/schema/commentv3.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const schema = z.object({ content: commentContentSchema });

export default function CommentEditModal() {
  const dialog = useDialogContext();

  const router = useRouter();
  const [value, , removeValue] = useLocalStorage<string | undefined>({
    key: 'commentContent',
    defaultValue: undefined,
  });
  const modelId = Number(router.query.id);
  const [initialContent, setInitialContent] = useState(value);

  const queryUtils = trpc.useUtils();

  const form = useForm({
    schema,
    defaultValues: { content: initialContent ?? '' },
    shouldUnregister: false,
  });

  const { isDirty, isSubmitted } = form.formState;
  useCatchNavigation({ unsavedChanges: isDirty && !isSubmitted });

  const saveCommentMutation = trpc.commentv3.create.useMutation({
    async onSuccess() {
      await queryUtils.commentv3.getSection.invalidate({ entityType: 'model', entityId: modelId });
      // Placements just spent uses, so the picker's counts are stale.
      await queryUtils.cosmetic.getStickerBalances.invalidate();
      handleClose();
    },
    onError: (error) => {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not save the comment',
      });
    },
  });
  const handleSaveComment = (values: z.infer<typeof schema>) => {
    const content = values.content?.trim() ?? '';
    if (content) saveCommentMutation.mutate({ entityType: 'model', entityId: modelId, content });
    else dialog.onClose();
  };

  const handleClose = () => {
    form.reset({ content: undefined });
    dialog.onClose();
  };

  useEffect(() => {
    if (!initialContent && value) {
      setInitialContent(value);
      form.reset({ content: value });
      removeValue();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent, removeValue, value]);

  const mutating = saveCommentMutation.isPending;

  return (
    <Modal
      opened={dialog.opened}
      onClose={!mutating ? dialog.onClose : () => ({})}
      title="Add a comment"
      closeOnClickOutside={!mutating}
      closeOnEscape={!mutating}
    >
      <Form form={form} onSubmit={handleSaveComment}>
        <Stack gap="md">
          <InputRTE
            name="content"
            placeholder="Type your thoughts..."
            includeControls={['formatting', 'link', 'mentions', 'sticker']}
            editorSize="xl"
            onSuperEnter={() => form.handleSubmit(handleSaveComment)()}
            inputClasses="break-words"
            // withLinkValidation
          />
          <Group justify="space-between">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saveCommentMutation.isPending}>
              Comment
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
