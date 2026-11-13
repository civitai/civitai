import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputTextArea, useForm } from '~/libs/form';
import {
  submitAppAccessRequestSchema,
  type SubmitAppAccessRequestInput,
} from '~/server/schema/app-access-request.schema';
import { APP_ACCESS_WHAT_TO_BUILD_MAX } from '~/shared/constants/app-access-request.constants';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** "Request access" form: one free-text answer, validated by the same schema the server uses. */
export default function AppAccessRequestModal() {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const form = useForm({
    schema: submitAppAccessRequestSchema,
    defaultValues: { whatToBuild: '' },
  });

  const submit = trpc.appAccessRequest.submit.useMutation({
    onSuccess: async () => {
      await utils.appAccessRequest.getMine.invalidate();
      showSuccessNotification({
        title: 'Request sent',
        message: 'A moderator will review it. You can check its status on this page.',
      });
      dialog.onClose();
    },
  });

  const onSubmit = (values: SubmitAppAccessRequestInput) => submit.mutate(values);

  return (
    <Modal {...dialog} title={<Text fw={600}>Request access</Text>} size="lg">
      <Form form={form} onSubmit={onSubmit}>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Tell us what you&apos;d like to make. A moderator reads every request.
          </Text>
          <InputTextArea
            name="whatToBuild"
            label="What do you want to build?"
            description="The idea, who it's for, and what it should do. Add links if they help — a sketch, a similar app, your work."
            autosize
            minRows={4}
            maxLength={APP_ACCESS_WHAT_TO_BUILD_MAX}
            withAsterisk
            data-testid="app-access-what-to-build"
          />
          {submit.error && (
            <Alert color="red" variant="light" data-testid="app-access-submit-error">
              {submit.error.message}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={dialog.onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={submit.isPending} data-testid="app-access-submit">
              Send request
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
