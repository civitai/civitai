import { Button, Card, Stack, Text, Title } from '@mantine/core';
import { closeModal, openConfirmModal } from '@mantine/modals';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRefreshSession } from '~/components/Stripe/memberships.util';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function RefreshSessionCard() {
  const currentUser = useCurrentUser();
  const { refreshSession } = useRefreshSession();

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
