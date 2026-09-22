import { Group, Stack, Switch, Text } from '@mantine/core';
import { usePushSubscription } from '~/components/Notifications/usePushSubscription';

/**
 * Device-level push on/off, shown only once browser permission exists — before that the soft-ask
 * owns the flow. Off unsubscribes THIS browser (deletes the server row); per-type settings are
 * untouched, so re-enabling restores them.
 */
export function PushDeviceToggle() {
  const { support, permission, active, busy, enable, disable } = usePushSubscription();

  if (support !== 'supported' || permission !== 'granted') return null;

  return (
    <Group justify="space-between" wrap="nowrap">
      <Stack gap={0}>
        <Text size="sm" fw={500}>
          Push on this device
        </Text>
        <Text size="xs" c="dimmed">
          Off stops all push notifications to this browser. Other devices are unaffected.
        </Text>
      </Stack>
      <Switch
        checked={active}
        disabled={busy}
        onChange={(e) => (e.target.checked ? enable() : disable())}
      />
    </Group>
  );
}
