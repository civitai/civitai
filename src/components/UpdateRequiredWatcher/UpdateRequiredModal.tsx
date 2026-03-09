import { Modal, Stack, Title, Text, Button, Group } from '@mantine/core';
import { Badge } from '~/components/Newsroom/Assets/Badge';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export default function UpdateRequiredModal({
  title,
  description,
}: {
  title?: string;
  description?: string;
}) {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} withCloseButton={false} closeOnEscape={false} closeOnClickOutside={false}>
      <Stack align="center">
        <div className="relative size-[120px]">
          <Badge />
        </div>
        <Title order={3}>{title ?? 'New Civitai version available!'}</Title>
        <Text>
          {description ??
            `It's time to refresh your browser to get the latest features from Civitai. If you don't, things may not work as expected.`}
        </Text>
        <Button onClick={() => window.location.reload()} radius="xl" size="lg">
          Update Now 🎉
        </Button>
        <Group gap={4}>
          <Text>😬</Text>
          <Text c="yellow" size="xs" onClick={() => dialog.onClose()} style={{ cursor: 'pointer' }}>
            Continue without updating
          </Text>
          <Text>😱</Text>
        </Group>
      </Stack>
    </Modal>
  );
}
