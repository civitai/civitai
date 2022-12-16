import { Button, Group, Modal, Radio, Stack, Text, Alert } from '@mantine/core';
import { showNotification, hideNotification } from '@mantine/notifications';
import { ReportReason } from '@prisma/client';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { z } from 'zod';
import { Form, InputImageUpload, InputRadioGroup, InputRTE, InputText, useForm } from '~/libs/form';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { imageSchema } from '~/server/schema/image.schema';
import { reportOwnershipDetailsSchema } from '~/server/schema/report.schema';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const schema = reportOwnershipDetailsSchema.extend({
  establishInterest: z.string().transform((x) => (x === 'yes' ? true : false)),
  images: imageSchema
    .array()
    .optional()
    .transform((images) => images?.map((x) => x.url)),
});

export default createRoutedContext({
  Element: ({ context, props }) => {
    const router = useRouter();
    const modelId = Number(router.query.id);

    const [uploading, setUploading] = useState(false);

    const form = useForm({
      schema: schema,
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

    const handleSubmit = (details: z.infer<typeof schema>) => {
      // console.log({ details });
      mutate({
        reason: ReportReason.Ownership,
        id: modelId,
        details,
      });
    };

    return (
      <Modal opened={context.opened} onClose={context.close} title="Report this uses my art">
        <Form form={form} onSubmit={handleSubmit}>
          <Stack>
            <Alert>
              If you believe that this model may have been trained using your art, please complete
              the form below for review
            </Alert>
            <InputText name="name" label="Name" withAsterisk clearable={false} />
            <InputText name="email" label="Email" withAsterisk clearable={false} />
            <InputText name="phone" label="Phone" clearable={false} />
            <InputRTE name="comment" label="Comment" />
            <InputImageUpload
              name="images"
              label="Images for comparison"
              withMeta={false}
              onChange={(values) => setUploading(values.some((x) => x.file))}
            />
            <Stack spacing={4}>
              <InputRadioGroup
                name="establishInterest"
                withAsterisk
                label="Are you interested in having an official model of your art style created and
                attributed to you?"
                description={
                  <Text>
                    You would receive 70% of any proceeds made from the use of your model on
                    Civitai.{' '}
                    <Text
                      variant="link"
                      component="a"
                      href="/content/art-and-ai#monetizing-your-art"
                      target="_blank"
                    >
                      Learn more
                    </Text>
                  </Text>
                }
              >
                <Radio value="yes" label="I'm interested" />
                <Radio value="no" label="$#!% off!" />
              </InputRadioGroup>
            </Stack>
            <Group grow>
              <Button variant="default" onClick={context.close}>
                Cancel
              </Button>
              <Button type="submit" loading={isLoading} disabled={uploading}>
                Submit
              </Button>
            </Group>
          </Stack>
        </Form>
      </Modal>
    );
  },
});
