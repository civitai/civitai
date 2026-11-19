import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconBellRinging, IconShare2 } from '@tabler/icons-react';
import { useEffect } from 'react';
import { isPushAskSnoozed, usePushPromptActions } from '~/components/Notifications/pushPrompt';
import { usePushSubscription } from '~/components/Notifications/usePushSubscription';
import { useIsMobile } from '~/hooks/useIsMobile';
import { trpc } from '~/utils/trpc';

/**
 * The pre-permission ask. Our own prompt first — the native browser prompt fires only after a yes,
 * so a "no" here costs nothing, while a "no" on the native prompt is a permanent denial.
 */
export function PushSoftAsk() {
  const { support, permission, active } = usePushSubscription();
  const { data: settings, isLoading } = trpc.user.getSettings.useQuery();

  if (support === 'needs-standalone') {
    return (
      <Paper withBorder p="md" radius="md">
        <Group wrap="nowrap">
          <IconShare2 size={24} className="shrink-0" />
          <Stack gap={4}>
            <Text fw={500}>Get notifications on this device</Text>
            <Text size="sm" c="dimmed">
              Add Civitai to your Home Screen to enable push notifications: tap the share button,
              then &ldquo;Add to Home Screen&rdquo;, and open Civitai from there.
            </Text>
          </Stack>
        </Group>
      </Paper>
    );
  }

  if (support !== 'supported' || active || isLoading) return null;
  // A browser-level denial is permanent and cannot be re-requested from code — nothing useful to ask.
  if (permission === 'denied') return null;

  if (isPushAskSnoozed(settings)) return null;

  return <PushSoftAskCard variant={permission === 'granted' ? 'finish' : 'new'} />;
}

function PushSoftAskCard({ variant }: { variant: 'new' | 'finish' }) {
  const isMobile = useIsMobile({ type: 'media' });
  const { busy } = usePushSubscription();
  const { track, notNow, enable } = usePushPromptActions(
    'settings-card',
    variant,
    isMobile ? 'mobile' : 'desktop'
  );

  useEffect(() => {
    track('shown');
  }, [track]);

  return (
    <Paper withBorder p="md" radius="md">
      <Group wrap="nowrap" align="flex-start">
        <IconBellRinging size={24} className="shrink-0" />
        <Stack gap="xs" className="flex-1">
          <Stack gap={4}>
            <Text fw={500}>Get notified even when Civitai is closed</Text>
            <Text size="sm" c="dimmed">
              Turn on push notifications to hear about replies, mentions and tips as they happen.
              You choose exactly which types get pushed.
            </Text>
          </Stack>
          <Group gap="xs">
            <Button size="xs" loading={busy} onClick={() => enable()}>
              Enable push notifications
            </Button>
            <Button size="xs" variant="subtle" color="gray" onClick={notNow}>
              Not now
            </Button>
          </Group>
        </Stack>
      </Group>
    </Paper>
  );
}
