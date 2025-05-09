import {
  Button,
  CloseButton,
  createStyles,
  Divider,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Modal,
} from '@mantine/core';
import { IconThumbDown } from '@tabler/icons-react';
import React from 'react';
import { z } from 'zod';
import { Form, InputTextArea, useForm } from '~/libs/form';
import { useUpdateImageStepMetadata } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

const useStyles = createStyles((theme) => ({
  actions: {
    [theme.fn.smallerThan('sm')]: {
      flexDirection: 'column',
      position: 'absolute',
      bottom: 0,
      left: 0,
      width: '100%',
      padding: theme.spacing.md,
    },
  },

  submitButton: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
      order: 1,
    },
  },
}));

const schema = z.object({
  message: z.string().trim().optional(),
});

const MAX_MESSAGE_LENGTH = 240;
export function TextToImageQualityFeedbackModal({
  workflowId,
  imageId,
  stepName,
  comments,
}: {
  workflowId: string;
  imageId: string;
  stepName: string;
  comments?: string;
}) {
  const dialog = useDialogContext();
  const { classes } = useStyles();
  const { updateImages, isLoading } = useUpdateImageStepMetadata();
  const form = useForm({ schema, defaultValues: { message: comments } });
  const handleSubmit = async (data: z.infer<typeof schema>) => {
    if (data.message)
      updateImages([
        {
          workflowId,
          stepName,
          images: {
            [imageId]: {
              comments: data.message,
            },
          },
        },
      ]);
    dialog.onClose();
  };

  const message = form.watch('message');

  return (
    <Modal {...dialog} withCloseButton={false} centered radius="lg">
      <Stack gap="md">
        <Group gap={8} justify="space-between">
          <Group>
            <ThemeIcon size="lg" color="red" radius="xl">
              <IconThumbDown size={18} />
            </ThemeIcon>
            <Text size="lg" weight={700}>
              Provide further feedback
            </Text>
          </Group>

          <CloseButton radius="xl" iconSize={22} onClick={dialog.onClose} />
        </Group>
        <Divider mx="-lg" />
        <Form form={form} onSubmit={handleSubmit} style={{ position: 'static' }}>
          <Stack gap="md">
            <InputTextArea
              name="message"
              inputWrapperOrder={['input', 'description']}
              placeholder="What was the issue? How can we improve?"
              variant="filled"
              minRows={2}
              maxLength={MAX_MESSAGE_LENGTH}
              description={`${message?.length ?? 0}/${MAX_MESSAGE_LENGTH} characters`}
              autosize
            />
            <Group className={classes.actions} justify="flex-end">
              <Button
                className={classes.submitButton}
                type="submit"
                radius="xl"
                loading={isLoading}
                disabled={!message?.length}
              >
                Submit feedback
              </Button>
            </Group>
          </Stack>
        </Form>
      </Stack>
    </Modal>
  );
}
