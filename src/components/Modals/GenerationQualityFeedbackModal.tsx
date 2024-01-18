import {
  Button,
  CloseButton,
  createStyles,
  Divider,
  Group,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconThumbDown } from '@tabler/icons-react';
import React from 'react';
import { z } from 'zod';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Form, InputTextArea, useForm } from '~/libs/form';
import { GENERATION_QUALITY } from '~/server/schema/generation.schema';
import { useGenerationQualityFeedback } from '../ImageGeneration/GenerationForm/generation.utils';

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

const { openModal, Modal } = createContextModal<{
  jobId: string;
  onSubmit: VoidFunction;
  onFailed: VoidFunction;
}>({
  name: 'imageGenQualityFeedbackModal',
  centered: true,
  radius: 'lg',
  withCloseButton: false,
  Element: ({ context, props: { jobId, onSubmit, onFailed } }) => {
    const { classes } = useStyles();
    const form = useForm({ schema, defaultValues: { message: undefined } });

    const { sendFeedback, sending } = useGenerationQualityFeedback();
    const handleSubmit = async (data: z.infer<typeof schema>) => {
      try {
        await sendFeedback({ jobId, reason: GENERATION_QUALITY.BAD, message: data.message });
        onSubmit();
        context.close();
      } catch (error) {
        // Error is handled in the hook
        onFailed();
      }
    };

    const message = form.watch('message');

    return (
      <Stack spacing="md">
        <Group spacing={8} position="apart">
          <Group>
            <ThemeIcon size="lg" color="red" radius="xl">
              <IconThumbDown size={18} />
            </ThemeIcon>
            <Text size="lg" weight={700}>
              Provide further feedback
            </Text>
          </Group>

          <CloseButton radius="xl" iconSize={22} onClick={context.close} />
        </Group>
        <Divider mx="-lg" />
        <Form form={form} onSubmit={handleSubmit} style={{ position: 'static' }}>
          <Stack spacing="md">
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
            <Group className={classes.actions} position="right">
              <Button className={classes.submitButton} type="submit" radius="xl" loading={sending}>
                Submit feedback
              </Button>
            </Group>
          </Stack>
        </Form>
      </Stack>
    );
  },
});

export const openGenQualityFeedbackModal = openModal;
export default Modal;
