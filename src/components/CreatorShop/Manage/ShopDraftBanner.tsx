import { Alert, Button, Group, Text, Tooltip } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';

// Reminds the owner their shop is private (disabled) and offers a one-click publish.
export function ShopDraftBanner({
  onEnable,
  enabling,
  disabledReason,
}: {
  onEnable: () => void;
  enabling: boolean;
  // When set, publishing is blocked (e.g. an empty shop) and this explains why.
  disabledReason?: string;
}) {
  return (
    <Alert color="yellow" icon={<IconEyeOff size={18} />} p="sm">
      <Group justify="space-between" wrap="nowrap" align="center" gap="sm">
        <div>
          <Text size="sm" fw={600}>
            Your shop is in draft
          </Text>
          <Text size="xs" c="dimmed">
            {disabledReason ?? "It's hidden from visitors until you publish it."}
          </Text>
        </div>
        <Tooltip label={disabledReason} disabled={!disabledReason} withArrow>
          <Button
            size="xs"
            color="yellow"
            loading={enabling}
            onClick={onEnable}
            disabled={!!disabledReason}
          >
            Publish shop
          </Button>
        </Tooltip>
      </Group>
    </Alert>
  );
}
