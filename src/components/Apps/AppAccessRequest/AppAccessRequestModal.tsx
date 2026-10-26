import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputTextArea, useForm } from '~/libs/form';
import {
  appAccessRequestFormSchema,
  toSubmitInput,
  type AppAccessRequestFormValues,
} from '~/server/schema/app-access-request.schema';
import {
  APP_ACCESS_LINKS_MAX,
  APP_ACCESS_WHAT_TO_BUILD_MAX,
} from '~/shared/constants/app-access-request.constants';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type AppAccessRequestModalProps = {
  /** The viewer's pending request, when they are editing it rather than starting one. */
  pending?: { whatToBuild: string; links: string[] } | null;
};

/**
 * "Request access" form. Submitting while a request is pending UPDATES it — the server keeps one
 * pending request per person — so the same form serves a first request and an edit.
 */
export default function AppAccessRequestModal({ pending }: AppAccessRequestModalProps) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const form = useForm({
    schema: appAccessRequestFormSchema,
    defaultValues: {
      whatToBuild: pending?.whatToBuild ?? '',
      links: pending?.links.join('\n') ?? '',
    },
  });

  const submit = trpc.appAccessRequest.submit.useMutation({
    onSuccess: async () => {
      await utils.appAccessRequest.getMine.invalidate();
      showSuccessNotification({
        title: pending ? 'Request updated' : 'Request sent',
        message: 'A moderator will review it. You can check its status on this page.',
      });
      dialog.onClose();
    },
  });

  const onSubmit = (values: AppAccessRequestFormValues) => submit.mutate(toSubmitInput(values));

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
            description="The idea, who it's for, and what it should do."
            autosize
            minRows={4}
            maxLength={APP_ACCESS_WHAT_TO_BUILD_MAX}
            withAsterisk
            data-testid="app-access-what-to-build"
          />
          <InputTextArea
            name="links"
            label="Links (optional)"
            description={`Anything that helps us picture it — a sketch, a similar app, your work. One per line, up to ${APP_ACCESS_LINKS_MAX}.`}
            autosize
            minRows={2}
            data-testid="app-access-links"
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
              {pending ? 'Update request' : 'Send request'}
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
