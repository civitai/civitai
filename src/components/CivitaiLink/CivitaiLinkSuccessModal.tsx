import { Stack, Title, Button, ThemeIcon } from '@mantine/core';
import { closeAllModals, ContextModalProps } from '@mantine/modals';
import { IconCheck } from '@tabler/icons';
import { z } from 'zod';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { Form, InputText, useForm } from '~/libs/form';

const schema = z.object({
  name: z.string(),
});

export default function CivitaiLinkSuccessModal({ context, id }: ContextModalProps) {
  const form = useForm({
    schema,
  });

  const { instance, renameInstance } = useCivitaiLink();

  const handleSubmit = (data: z.infer<typeof schema>) => {
    if (!instance?.id) return;
    renameInstance(instance.id, data.name);
    closeAllModals();
  };

  return (
    <Stack p="xl">
      <Stack spacing={0} justify="center" align="center">
        <ThemeIcon color="green" size="xl" radius="xl">
          <IconCheck />
        </ThemeIcon>
        <Title align="center">{`You're connected!`}</Title>
      </Stack>

      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <InputText name="name" label="Name your stable diffusion instance" placeholder="name" />
          <Button type="submit">Save</Button>
        </Stack>
      </Form>
    </Stack>
  );
}
