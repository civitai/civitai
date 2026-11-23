import { Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { openLoginHere } from '~/components/Login/requireLogin';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputTextArea, useForm } from '~/libs/form';
import { useIsClient } from '~/providers/IsClientProvider';
import { useSession } from '~/providers/SessionProvider';
import {
  submitAppAccessRequestSchema,
  type SubmitAppAccessRequestInput,
} from '~/server/schema/app-access-request.schema';
import {
  APP_ACCESS_WHAT_TO_BUILD_MAX,
  REQUEST_ACCESS_PARAM,
  type AppAccessRequestStatus,
} from '~/shared/constants/app-access-request.constants';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const STATUS_BADGE: Record<AppAccessRequestStatus, { label: string; color: string }> = {
  pending: { label: 'Pending review', color: 'yellow' },
  approved: { label: 'Approved', color: 'green' },
  declined: { label: 'Not approved', color: 'gray' },
};

/** The form's text box, which the deep link focuses. */
const WHAT_TO_BUILD_ID = 'app-access-what-to-build';

/**
 * Acts on the deep link once the panel's state is known, then drops the param with a shallow
 * replace so a refresh or Back does not act again.
 *
 * - Signed out: the same sign-in the button uses, returning to the URL WITH the param, so the
 *   form is in front of them after sign-in. The param is dropped first, so Back from sign-in
 *   lands on the plain page instead of bouncing into sign-in again.
 * - A pending or approved request: nothing; the panel already shows that status.
 * - No request, or a declined one: the form's text box is focused (the form is always on the
 *   page, so there is nothing to open).
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
    else if (canRequest) document.getElementById(WHAT_TO_BUILD_ID)?.focus();
  }, [wanted, ready, signedOut, canRequest, router]);
}

/**
 * The request itself: an OPTIONAL "what do you want to build?" and one button, so a request is
 * one click. Validated by the same schema the server uses (only the length cap is left).
 *
 * The server decides what a request becomes. Approved on the spot (`app-access-auto-approve`, for
 * an account that passes its checks), the grant is already on the person's refreshed session, so
 * the page reloads straight into the build surface — the page mode is decided in
 * `getServerSideProps` from the session's flags, which a client re-render would not re-run.
 * Pending, the panel shows that status instead.
 */
function AppAccessRequestForm({
  submitLabel,
  onRequest,
  statusLoading = false,
}: {
  submitLabel: string;
  onRequest?: () => void;
  /** The viewer's request status has not loaded yet: the button waits, so a click cannot race it. */
  statusLoading?: boolean;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const form = useForm({
    schema: submitAppAccessRequestSchema,
    defaultValues: { whatToBuild: '' },
  });

  const submit = trpc.appAccessRequest.submit.useMutation({
    onSuccess: async (request) => {
      if (request.status === 'approved') {
        showSuccessNotification({
          title: 'You have access',
          message: 'Opening the App Assistant…',
        });
        router.reload();
        return;
      }
      await utils.appAccessRequest.getMine.invalidate();
      showSuccessNotification({
        title: 'Request sent',
        message: 'A moderator will review it. You can check its status on this page.',
      });
    },
  });

  const onSubmit = (values: SubmitAppAccessRequestInput) => {
    onRequest?.();
    submit.mutate(values);
  };

  return (
    <Form form={form} onSubmit={onSubmit} style={{ width: '100%' }}>
      <Stack gap="sm" align="flex-start" data-testid="app-access-request-form">
        <InputTextArea
          name="whatToBuild"
          id={WHAT_TO_BUILD_ID}
          label="What do you want to build? (optional)"
          description="The idea, who it's for, and what it should do. Add links if they help — a sketch, a similar app, your work."
          autosize
          minRows={3}
          maxLength={APP_ACCESS_WHAT_TO_BUILD_MAX}
          w="100%"
          data-testid="app-access-what-to-build"
        />
        {submit.error && (
          <Alert color="red" variant="light" data-testid="app-access-submit-error">
            {submit.error.message}
          </Alert>
        )}
        <Button
          type="submit"
          leftSection={<IconSend size={16} />}
          loading={submit.isPending || statusLoading}
          data-testid="app-access-request-button"
        >
          {submitLabel}
        </Button>
      </Stack>
    </Form>
  );
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
 * both show the form, and the status replaces it once the query lands.
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
    // which case nothing is focused and the form is still there).
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

  if (!request) {
    return (
      <AppAccessRequestForm
        submitLabel="Request access"
        onRequest={onRequest}
        // Deferred to after mount: React Query reports the first CLIENT render as fetching and
        // the server render as idle, and a differing `loading` would be a hydration mismatch.
        statusLoading={isClient && isLoading}
      />
    );
  }

  const badge = STATUS_BADGE[request.status];
  return (
    <Stack gap="xs" data-testid="app-access-request-status" data-status={request.status} w="100%">
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
        <AppAccessRequestForm submitLabel="Request access again" onRequest={onRequest} />
      )}
    </Stack>
  );
}
