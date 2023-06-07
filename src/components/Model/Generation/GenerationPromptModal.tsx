import { Modal, Stack, Group, Button } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Form, InputText, InputTextArea, useForm } from '~/libs/form';

const schema = z.object({
  name: z.string().trim().min(1, 'Please provide a name'),
  prompt: z.string().trim().min(1, 'Please provide a prompt'),
});

export function GenerationPromptModal({ prompt, opened, onClose }: Props) {
  const form = useForm({ schema, defaultValues: { name: '', prompt } });

  const handleSubmit = (data: z.infer<typeof schema>) => {
    console.log(data);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add Explorable Prompt">
      <Form form={form} onSubmit={handleSubmit}>
        <Stack spacing="xs">
          <AlertWithIcon icon={<IconAlertCircle />} px="xs">
            {`This will generate images similar to the one you've selected with the level of variation driven by your selection below.`}
          </AlertWithIcon>
          <InputText
            name="name"
            label="Display name"
            placeholder="e.g.: Unicorn kitten"
            withAsterisk
          />
          <InputTextArea
            name="prompt"
            label="Prompt"
            placeholder="e.g.: A kitten with a unicorn horn"
            rows={3}
            withAsterisk
          />
          <Group position="right">
            <Button type="submit">Add</Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}

type Props = {
  opened: boolean;
  onClose: VoidFunction;
  prompt?: any;
};
