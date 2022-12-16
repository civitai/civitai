import { Button, Group, Modal, Stack } from '@mantine/core';
import { showNotification, hideNotification } from '@mantine/notifications';
import { ReportReason } from '@prisma/client';
import { useRouter } from 'next/router';
import { ImageUpload } from '~/components/ImageUpload/ImageUpload';
import { Form, InputCheckbox, InputRTE, InputText, useForm } from '~/libs/form';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { ownershipReportInputSchema } from '~/server/schema/report.schema';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  Element: ({ context, props }) => {
    const router = useRouter();
    const modelId = Number(router.query.id);
    const form = useForm({
      schema: ownershipReportInputSchema,
      shouldUnregister: false,
    });

    const queryUtils = trpc.useContext();
    const { mutate, isLoading } = trpc.model.report.useMutation({
      onMutate() {
        showNotification({
          id: 'sending-report',
          loading: true,
          disallowClose: true,
          autoClose: false,
          message: 'Sending report...',
        });
      },
      async onSuccess(_, variables) {
        showSuccessNotification({
          title: 'Model reported',
          message: 'Your request has been received',
        });
        context.close();
        await queryUtils.model.getById.invalidate({ id: variables.id });
      },
      onError(error) {
        showErrorNotification({
          error: new Error(error.message),
          title: 'Unable to send report',
          reason: 'An unexpected error occurred, please try again',
        });
      },
      onSettled() {
        hideNotification('sending-report');
      },
    });

    const handleSubmit = (details: typeof ownershipReportInputSchema) => {
      mutate({
        reason: ReportReason.Ownership,
        id: modelId,
        details,
      });
    };

    return (
      <Modal opened={context.opened} onClose={context.close} title="Report Ownership">
        <Form form={form} onSubmit={}>
          <Stack>
            <InputText name="name" label="Name" withAsterisk />
            <InputText name="email" label="Email" withAsterisk />
            <InputText name="phone" label="Phone" />
            <InputRTE name="comment" label="Comment" />
            <ImageUpload
              label="Images"
              onChange={(value) =>
                form.setValue(
                  'images',
                  value.map((x) => x.url)
                )
              }
            />
            <InputCheckbox name="establishInterest" label="Establish interest" />
            <Group grow>
              <Button variant="default" onClick={context.close}>
                Cancel
              </Button>
              <Button type="submit">Submit</Button>
            </Group>
          </Stack>
        </Form>
      </Modal>
    );
  },
});
