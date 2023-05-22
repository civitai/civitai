import { Button, Stack } from '@mantine/core';
import { closeAllModals, openModal } from '@mantine/modals';
import {
  RichTextEditor,
  RichTextEditorControlProps,
  useRichTextEditorContext,
} from '@mantine/tiptap';
import { IconReportAnalytics } from '@tabler/icons';
import { z } from 'zod';

import { Form, InputText, useForm } from '~/libs/form';
import { STRAWPOLL_REGEX } from '~/libs/tiptap/extensions/StrawPoll';

const schema = z.object({
  url: z
    .string()
    .url('Please provide a valid URL')
    .regex(STRAWPOLL_REGEX, 'Please provide an StrawPoll URL'),
});
const controlTitle = 'Embed StrawPoll';

export function InsertStrawPollControl(props: Props) {
  const { editor } = useRichTextEditorContext();
  const form = useForm({
    schema,
    defaultValues: { url: '' },
    shouldUnregister: false,
  });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    const { url } = values;

    editor.commands.setStrawPollEmbed({ src: url });
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
              label="StrawPoll URL"
              name="url"
              placeholder="https://www.strawpoll.com/polls/rae5gcp1"
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
      <IconReportAnalytics size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;
