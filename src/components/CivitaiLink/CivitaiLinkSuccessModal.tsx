import { Button, Center, Group, Modal, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import * as z from 'zod';
import { AppRow } from '~/components/CivitaiLink/CivitaiLinkAppRow';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
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
  const name = form.watch('name');

  const handleSubmit = (data: z.infer<typeof schema>) => {
    if (!instance?.id) return;
    // Empty means "keep what it has" — the wizard's last step may already have
    // named it, and submitting blank would wipe that.
    const trimmed = data.name?.trim();
    if (trimmed) renameInstance(instance.id, trimmed);
    dialogStore.closeAll();
  };

  return (
    <Modal {...dialog} withCloseButton={false} closeOnClickOutside={false} closeOnEscape={false}>
      <Form form={form} onSubmit={handleSubmit}>
        <Stack gap="lg" pt="md">
          <Center>
            <Center
              w={72}
              h={72}
              bg="var(--mantine-color-success-light)"
              style={{ borderRadius: 999 }}
            >
              <IconCheck size={32} className="text-success-5" />
            </Center>
          </Center>

          <Stack gap={6} align="center">
            <Text
              fz={24}
              fw={700}
              c="var(--mantine-color-bright)"
              ta="center"
            >{`You're connected`}</Text>
            <Text fz="sm" c="dimmed" ta="center" lh={1.5}>
              This machine can now receive models straight from Civitai.
            </Text>
          </Stack>

          <InputText
            name="name"
            label="Name this app"
            description="Shown wherever you pick where to send a model."
            placeholder="Workstation"
          />

          <AppRow name={name || instance?.name || 'Workstation'} connected />

          <Group justify="space-between" mt="xs">
            <Button variant="subtle" color="gray" onClick={() => dialogStore.closeAll()}>
              Skip
            </Button>
            <Button type="submit">Save and finish</Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
