import { CloseButton, Group, Modal, Stack, Title } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { SupportContent } from '~/components/Support/SupportContent';

export default function SupportModal() {
  const dialog = useDialogContext();

  return (
    <Modal
      {...dialog}
      size="auto"
      // 🔴 `py-6` HERE OUTRANKS THE SHELL'S MODAL RULE, so it has to carry the
      // inset itself. A Tailwind utility in `classNames` is UNLAYERED, which
      // beats the `@layer mantine` rule in globals.css that raises a
      // non-fullScreen modal's vertical offset to clear the display cutout.
      // This is the only `inner:` override in the app, and left as a flat 24px
      // it is the one dialog that can still land under a 47-59px notch.
      //
      // `max(...)` and not addition: 24px is the design offset on every device
      // and the inset only has to win where it is larger.
      classNames={{
        content: 'p-10',
        inner:
          'pt-[max(1.5rem,var(--safe-area-inset-top))] pb-[max(1.5rem,var(--safe-area-inset-bottom))]',
        body: 'p-0',
      }}
      withCloseButton={false}
      centered
    >
      <Stack gap={32}>
        <Group align="flex-start" justify="space-between" gap={80} wrap="nowrap">
          <Title size={32} className="font-semibold text-gray-1">
            Let&apos;s pick a support option that works for you
          </Title>
          <CloseButton aria-label="Close support modal" size="xl" onClick={dialog.onClose} />
        </Group>
        <SupportContent />
      </Stack>
    </Modal>
  );
}
