import { Anchor, Group, Switch, Text } from '@mantine/core';
import { useServerDomains } from '~/providers/AppProvider';
import { useSyncAccount } from '~/hooks/useSyncAccount';

export function ComCardPreviewToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Switch
      size="xs"
      label="Preview civitai.com card"
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

export function RedCardLink({ path }: { path: string }) {
  const serverDomains = useServerDomains();
  const syncAccount = useSyncAccount();
  if (!serverDomains.red) return null;
  return (
    <Group gap={4}>
      <Text size="xs" c="dimmed">
        This is the civitai.com card.
      </Text>
      <Anchor size="xs" href={syncAccount(`//${serverDomains.red}${path}`)}>
        See the civitai.red card
      </Anchor>
    </Group>
  );
}
