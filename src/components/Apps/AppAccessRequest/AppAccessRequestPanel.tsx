import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsClient } from '~/providers/IsClientProvider';
import type { AppAccessRequestStatus } from '~/shared/constants/app-access-request.constants';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import type { AppAccessRequestModalProps } from './AppAccessRequestModal';

const AppAccessRequestModal = dynamic(() => import('./AppAccessRequestModal'));

const STATUS_BADGE: Record<AppAccessRequestStatus, { label: string; color: string }> = {
  pending: { label: 'Pending review', color: 'yellow' },
  approved: { label: 'Approved', color: 'green' },
  declined: { label: 'Not approved', color: 'gray' },
};

export function openAppAccessRequestModal(props: AppAccessRequestModalProps) {
  dialogStore.trigger({ id: 'app-access-request', component: AppAccessRequestModal, props });
}

/**
 * The "Request access" control on the `/apps/build` pitch, and where the viewer sees what became
 * of their request. Signed out, the button goes through the sign-in flow first.
 *
 * The status comes from a client-only query, so the server render and the first client paint
 * both show the plain button, and the status replaces it once the query lands.
 */
export function AppAccessRequestPanel({ onRequest }: { onRequest?: () => void }) {
  const currentUser = useCurrentUser();
  const isClient = useIsClient();
  const { data: request, isLoading } = trpc.appAccessRequest.getMine.useQuery(undefined, {
    enabled: !!currentUser,
  });

  if (!currentUser) {
    return (
      <LoginRedirect reason="perform-action">
        <Button leftSection={<IconSend size={16} />} data-testid="app-access-request-button">
          Request access
        </Button>
      </LoginRedirect>
    );
  }

  const open = () => {
    onRequest?.();
    openAppAccessRequestModal({
      pending:
        request?.status === 'pending'
          ? { whatToBuild: request.whatToBuild, links: request.links }
          : null,
    });
  };

  if (!request) {
    return (
      <Button
        leftSection={<IconSend size={16} />}
        onClick={open}
        // Deferred to after mount: React Query reports the first CLIENT render as fetching and
        // the server render as idle, and a differing `loading` would be a hydration mismatch.
        loading={isClient && isLoading}
        data-testid="app-access-request-button"
      >
        Request access
      </Button>
    );
  }

  const badge = STATUS_BADGE[request.status];
  return (
    <Stack gap="xs" data-testid="app-access-request-status" data-status={request.status}>
      <Group gap="xs">
        <Badge color={badge.color} variant="light">
          {badge.label}
        </Badge>
        <Text size="sm" c="dimmed">
          {request.status === 'pending'
            ? `Sent ${formatDate(request.updatedAt)}`
            : `Reviewed ${formatDate(request.reviewedAt ?? request.updatedAt)}`}
        </Text>
      </Group>
      <Text size="sm">
        {request.status === 'pending' &&
          'A moderator will review your request. You can change it until then.'}
        {request.status === 'approved' &&
          'Your request was approved. Access is switched on by hand, so the App Assistant can take a little while to appear here.'}
        {request.status === 'declined' &&
          'Your last request was not approved. You can send a new one.'}
      </Text>
      {request.status !== 'approved' && (
        <Group>
          <Button
            variant="light"
            onClick={open}
            data-testid={
              request.status === 'pending' ? 'app-access-request-edit' : 'app-access-request-button'
            }
          >
            {request.status === 'pending' ? 'Update request' : 'Request access again'}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
