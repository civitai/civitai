import { Stack, Title, Button, ThemeIcon, Modal } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import * as z from 'zod';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { useDialogContext } from '~/components/Dialog/DialogContext';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Form, InputText, useForm } from '~/libs/form';

const schema = z.object({
  name: z.string(),
});

export default function CivitaiLinkSuccessModal() {
  const dialog = useDialogContext();
  const form = useForm({
    schema,
  });

  const { instance, renameInstance } = useCivitaiLink();

  const handleSubmit = (data: z.infer<typeof schema>) => {
    if (!instance?.id) return;
    renameInstance(instance.id, data.name);
    dialogStore.closeAll();
  };

  return (
    <Modal {...dialog} withCloseButton={false} closeOnClickOutside={false} closeOnEscape={false}>
      <Stack p="xl">
        <Stack gap={0} justify="center" align="center">
          <ThemeIcon color="green" size="xl" radius="xl">
            <IconCheck />
          </ThemeIcon>
          <Title ta="center">{`You're connected!`}</Title>
        </Stack>

        <Form form={form} onSubmit={handleSubmit}>
          <Stack>
            <InputText name="name" label="Name your Stable Diffusion instance" placeholder="name" />
            <Button type="submit">Save</Button>
          </Stack>
        </Form>
      </Stack>
    </Modal>
  );
}
