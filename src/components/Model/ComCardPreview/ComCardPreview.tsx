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
  return (
    <Group gap={4}>
      <Text size="xs" c="dimmed">
        You&apos;re seeing this model&apos;s civitai.com card: its title and description differ from
        the original on civitai.red.
      </Text>
      <Anchor size="xs" href={syncAccount(`//${serverDomains.red}${path}`)}>
        See the civitai.red card
      </Anchor>
    </Group>
  );
}
