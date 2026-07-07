import { Alert, Button, Group, Text } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';

// Reminds the owner their shop is private (disabled) and offers a one-click publish.
export function ShopDraftBanner({
  onEnable,
  enabling,
}: {
  onEnable: () => void;
  enabling: boolean;
}) {
  return (
    <Alert color="yellow" icon={<IconEyeOff size={18} />} p="sm">
      <Group justify="space-between" wrap="nowrap" align="center" gap="sm">
        <div>
          <Text size="sm" fw={600}>
            Your shop is in draft
          </Text>
          <Text size="xs" c="dimmed">
            It&apos;s hidden from visitors until you publish it.
          </Text>
        </div>
        <Button size="xs" color="yellow" loading={enabling} onClick={onEnable}>
          Publish shop
        </Button>
      </Group>
    </Alert>
  );
}
