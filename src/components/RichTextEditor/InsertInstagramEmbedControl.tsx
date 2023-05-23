import { Button, Stack } from '@mantine/core';
import { closeAllModals, openModal } from '@mantine/modals';
import {
  RichTextEditor,
  RichTextEditorControlProps,
  useRichTextEditorContext,
} from '@mantine/tiptap';
import { IconBrandInstagram } from '@tabler/icons-react';
import { z } from 'zod';

import { Form, InputText, useForm } from '~/libs/form';
import { INSTAGRAM_REGEX } from '~/libs/tiptap/extensions/Instagram';

const schema = z.object({
  url: z
    .string()
    .url('Please provide a valid URL')
    .regex(INSTAGRAM_REGEX, 'Please provide an Instagram URL'),
});
const controlTitle = 'Embed Instagram Post';

export function InsertInstagramEmbedControl(props: Props) {
  const { editor } = useRichTextEditorContext();
  const form = useForm({
    schema,
    defaultValues: { url: '' },
    shouldUnregister: false,
  });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    const { url } = values;

    editor.commands.setInstagramEmbed({ src: url });
    closeAllModals();
    form.reset();
  };

  const handleClick = () => {
    openModal({
      title: controlTitle,
      children: (
        <Form form={form} onSubmit={handleSubmit}>
          <Stack spacing="xs">
            <InputText
              label="Instagram URL"
              name="url"
              placeholder="https://www.instagram.com/p/COZ3QqYhZ5I"
              withAsterisk
            />
            <Button type="submit" fullWidth>
              Submit
            </Button>
          </Stack>
        </Form>
      ),
      onClose: () => form.reset(),
    });
  };

  return (
    <RichTextEditor.Control
      {...props}
      onClick={handleClick}
      aria-label={controlTitle}
      title={controlTitle}
    >
      <IconBrandInstagram size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;
