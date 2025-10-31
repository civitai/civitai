import { Button, Group, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export function CareerResetModal({ title, message }: { title: string; message: string }) {
  const dialog = useDialogContext();

  return (
    <Modal
      {...dialog}
      size="md"
      title={null}
      centered
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
    >
      <Stack gap="md">
        <Group gap="md" wrap="nowrap">
          <ThemeIcon size={64} radius="xl" variant="light" color="blue">
            <IconRefresh size={32} />
          </ThemeIcon>
          <div>
            <Text size="xl" fw={600}>
              {title}
            </Text>
            <Text size="sm" c="dimmed" mt={4}>
              {message}
            </Text>
          </div>
        </Group>

        <Text size="sm">
          Your Knights of New Order career has been completely reset. All your progress, including:
        </Text>

        <Stack gap="xs" ml="md">
          <Text size="sm" c="dimmed">
            • Experience points (XP) reset to 0
          </Text>
          <Text size="sm" c="dimmed">
            • Level reset to 1
          </Text>
          <Text size="sm" c="dimmed">
            • Rank reset to Acolyte
          </Text>
          <Text size="sm" c="dimmed">
            • All stats (fervor, blessed buzz, smites) cleared
          </Text>
        </Stack>

        <Text size="sm" fw={500} mt="xs">
          You can start fresh and climb the ranks again!
        </Text>

        <Group justify="flex-end" mt="md">
          <Button onClick={dialog.onClose} fullWidth size="md">
            I Understand
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default CareerResetModal;
