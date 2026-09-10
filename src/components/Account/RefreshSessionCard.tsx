import { Button, Card, Stack, Text, Title } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useRefreshSession } from '~/components/Stripe/memberships.util';
import { PointerCard } from '~/components/Account/SettingsLayout';

export function RefreshSessionCard({ flat }: { flat?: boolean }) {
  const { refreshSession } = useRefreshSession();

  if (flat)
    return (
      <PointerCard
        icon={<IconRefresh size={18} />}
        title="Refresh my session"
        description="Reloads your account data. Safe to run any time."
        action={
          <Button variant="default" size="compact-sm" onClick={refreshSession}>
            Refresh
          </Button>
        }
      />
    );

  return (
    <Card withBorder>
      <Stack>
        <Title order={2}>Refresh my Session</Title>
        <Text size="sm">
          Support may ask you to refresh your Civitai session. Click the button below to clear
          internal caches, which can help resolve minor issues without affecting your account data
          or settings.
        </Text>
        <Button variant="outline" color="blue" onClick={refreshSession}>
          Refresh my Session
        </Button>
      </Stack>
    </Card>
  );
}
