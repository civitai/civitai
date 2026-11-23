import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { openDialog } from '~/components/Dialog/openDialog';
import { openLoginHere } from '~/components/Login/requireLogin';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsClient } from '~/providers/IsClientProvider';
import { useSession } from '~/providers/SessionProvider';
import {
  REQUEST_ACCESS_PARAM,
  type AppAccessRequestStatus,
} from '~/shared/constants/app-access-request.constants';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const STATUS_BADGE: Record<AppAccessRequestStatus, { label: string; color: string }> = {
  pending: { label: 'Pending review', color: 'yellow' },
  approved: { label: 'Approved', color: 'green' },
  declined: { label: 'Not approved', color: 'gray' },
};

export function openAppAccessRequestModal() {
  openDialog(() => import('./AppAccessRequestModal'), undefined, { id: 'app-access-request' });
}

/**
 * Acts on the deep link once the panel's state is known, then drops the param with a shallow
 * replace so a refresh or Back does not act again.
 *
 * - Signed out: the same sign-in the button uses, returning to the URL WITH the param, so the
 *   form opens after sign-in. The param is dropped first, so Back from sign-in lands on the plain
 *   page instead of bouncing into sign-in again.
 * - A pending or approved request: nothing opens; the panel already shows that status.
 * - No request, or a declined one: the form opens.
 *
 * Waits for the session to resolve (a loading session is not a signed-out one) and for
 * `getMine`'s answer, and acts at most once per mount.
 */
function useRequestAccessDeepLink({
  signedOut,
  ready,
  canRequest,
}: {
  signedOut: boolean;
  ready: boolean;
  canRequest: boolean;
}) {
  const router = useRouter();
  const handled = useRef(false);
  const wanted = router.isReady && router.query[REQUEST_ACCESS_PARAM] !== undefined;

  useEffect(() => {
    if (!wanted || handled.current || !ready) return;
    handled.current = true;

    const returnUrl = router.asPath;
    const query = { ...router.query };
    delete query[REQUEST_ACCESS_PARAM];
    const dropped = router
      .replace({ pathname: router.pathname, query }, undefined, { shallow: true })
      .catch(() => undefined);

    if (signedOut) void dropped.then(() => openLoginHere('perform-action', returnUrl));
    else if (canRequest) openAppAccessRequestModal();
  }, [wanted, ready, signedOut, canRequest, router]);
}

/**
 * The "Request access" control on the `/apps/build` pitch, and where the viewer sees what became
 * of their request. Signed out, the button goes through the sign-in flow first.
 *
 * Approval is the grant: it puts the viewer on the builder flags (App Assistant included) and
 * busts their session, so the next page load renders the assistant here. That is why the approved
 * state offers a full page load rather than a client navigation — the page mode is decided in
 * `getServerSideProps` from the session's flags.
 *
 * The status comes from a client-only query, so the server render and the first client paint
 * both show the plain button, and the status replaces it once the query lands.
 */
export function AppAccessRequestPanel({ onRequest }: { onRequest?: () => void }) {
  const currentUser = useCurrentUser();
  const isClient = useIsClient();
  const { status: sessionStatus } = useSession();
  const { data: request, isLoading } = trpc.appAccessRequest.getMine.useQuery(undefined, {
    enabled: !!currentUser,
  });
  const signedOut = !currentUser && sessionStatus === 'unauthenticated';
  useRequestAccessDeepLink({
    signedOut,
    // `getMine` answers null for "never asked", so undefined means not loaded yet (or failed, in
    // which case nothing opens and the button is still there).
    ready: signedOut || (!!currentUser && request !== undefined),
    canRequest: !request || request.status === 'declined',
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
    openAppAccessRequestModal();
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
          {request.reviewedAt
            ? `Reviewed ${formatDate(request.reviewedAt)}`
            : `Sent ${formatDate(request.createdAt)}`}
        </Text>
      </Group>
      <Text size="sm">
        {request.status === 'pending' && 'A moderator will review your request.'}
        {request.status === 'approved' &&
          'You can build apps now. Reload this page and the App Assistant opens here.'}
        {request.status === 'declined' && 'Your request was not approved. You can send a new one.'}
      </Text>
      {request.status === 'approved' && (
        // A full page load, not a client navigation: the assistant view is chosen server-side.
        <Button component="a" href="/apps/build" data-testid="app-access-request-open-assistant">
          Open the App Assistant
        </Button>
      )}
      {request.status === 'declined' && (
        <Button variant="light" onClick={open} data-testid="app-access-request-button">
          Request access again
        </Button>
      )}
    </Stack>
  );
}
