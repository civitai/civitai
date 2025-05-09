import { CloseButton, Group, Modal, Stack, Title } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { SupportContent } from '~/components/Support/SupportContent';

export default function SupportModal() {
  const dialog = useDialogContext();

  return (
    <Modal
      {...dialog}
      size="xl"
      styles={{ modal: { padding: '40px !important' }, inner: { padding: '24px 0' } }}
      withCloseButton={false}
      centered
    >
      <Stack gap={32}>
        <Group align="flex-start" justify="space-between" gap={80} wrap="nowrap">
          <Title size={32} weight={600} color="gray.1">
            Let&apos;s pick a support option that works for you
          </Title>
          <CloseButton aria-label="Close support modal" size="xl" onClick={dialog.onClose} />
        </Group>
        <SupportContent />
      </Stack>
    </Modal>
  );
}
