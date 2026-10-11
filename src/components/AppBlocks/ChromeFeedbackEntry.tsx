import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconLock, IconMessage2 } from '@tabler/icons-react';
import { useState } from 'react';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { FEEDBACK_MESSAGE_MAX_LENGTH } from '~/shared/constants/feedback.constants';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { trpc } from '~/utils/trpc';
import type { AppFeedbackRequest } from './appFeedbackChrome';
import {
  APP_FEEDBACK_SENT_MESSAGE,
  APP_FEEDBACK_PRIVATE_NOTICE,
  appFeedbackEntryRequest,
  appFeedbackModalTitle,
  appFeedbackSentWithLine,
  appFeedbackSubmitErrorMessage,
  buildAppFeedbackCreateInput,
  canSubmitAppFeedback,
} from './appFeedbackChrome';

/**
 * "Send feedback to developer": private, text-only feedback from a running App Block to its
 * developer (their collaborators and moderators read it too). The entry point is an icon button in
 * the chrome bar itself, beside the ⋮ trigger, on every surface (page host and model slot, desktop
 * bar and compact shell) — it used to be a ⋮ menu item, which buried the one action whose whole
 * point is to be reached while the app is in front of you. It hands what it resolved UP to
 * `AppBlockChrome`, which owns the modal, so the modal's lifetime does not depend on where the
 * trigger lives (the ⋮ surface unmounts its children on close).
 */

/**
 * Everything the modal needs, captured when the button is clicked. The request is part of the
 * snapshot, not re-derived from the chrome's props: the page host can be reused across apps
 * without remounting, and a modal titled for app A must not submit to app B.
 */
export type AppFeedbackModalTarget = {
  request: AppFeedbackRequest;
  appName: string;
  appBlockVersion: string | null;
};

export const APP_FEEDBACK_BUTTON_LABEL = 'Send feedback to developer';

/** Hover for a pointer, focus so a keyboard user also sees the label (Mantine's default is hover only). */
const TOOLTIP_EVENTS = { hover: true, focus: true, touch: false };

/**
 * The chrome-bar button. Renders `null` for a viewer the server would refuse.
 *
 * Split in two for the same reason as `ChromeReviewMenuItem`: the eligibility query is mounted
 * only once the cheap synchronous gates (`appFeedbackEntryRequest`) have passed, so a signed-out
 * viewer or one without store access never issues it.
 */
export function ChromeFeedbackButton({
  request,
  onOpenFeedback,
}: {
  request: AppFeedbackRequest | null;
  onOpenFeedback: (target: AppFeedbackModalTarget) => void;
}) {
  const currentUser = useCurrentUser();
  const features = useOptionalFeatureFlags();
  const entry = appFeedbackEntryRequest({
    isSignedIn: !!currentUser,
    hasStoreAccess: hasAppsStoreAccess(features),
    request,
  });
  if (!entry) return null;
  return <ChromeFeedbackButtonBody request={entry} onOpenFeedback={onOpenFeedback} />;
}

function ChromeFeedbackButtonBody({
  request,
  onOpenFeedback,
}: {
  request: AppFeedbackRequest;
  onOpenFeedback: (target: AppFeedbackModalTarget) => void;
}) {
  // `getEligibility` runs the same predicate as `appFeedback.create`, so the button is never
  // offered where the submit would be refused. Unlike the old ⋮ item this query runs when the
  // chrome mounts rather than when a menu opens: a visible button has to know up front.
  const { data } = trpc.appFeedback.getEligibility.useQuery(
    { target: request.target },
    { retry: false }
  );
  if (!data?.eligible) return null;
  const { appName, appBlockVersion } = data;
  return (
    <Tooltip label={APP_FEEDBACK_BUTTON_LABEL} withArrow openDelay={300} events={TOOLTIP_EVENTS}>
      <ActionIcon
        variant="subtle"
        color="gray"
        // `sm` like every other icon button in the bar: it keeps the row at its pinned resting
        // height (`CHROME_BAR_PX`). No `flexShrink: 0` needed: Mantine gives an ActionIcon
        // `min-width: var(--ai-size)`, so a long app name cannot squeeze it.
        size="sm"
        aria-label={APP_FEEDBACK_BUTTON_LABEL}
        data-testid="app-block-feedback-button"
        onClick={() => onOpenFeedback({ request, appName, appBlockVersion })}
      >
        <IconMessage2 size={16} stroke={1.5} />
      </ActionIcon>
    </Tooltip>
  );
}

export function AppFeedbackModal({
  target,
  onClose,
}: {
  target: AppFeedbackModalTarget;
  onClose: () => void;
}) {
  // Same viewport rule as `ReviewListingModal`: a modal IS the viewport.
  const isMobile = useIsMobile({ type: 'media' });
  const { request } = target;
  const [message, setMessage] = useState('');
  // Not `useFeedbackSubmission`: that hook attaches host-page diagnostics (session id, console
  // and network errors) to every submit, and none of that is collected for app feedback.
  const create = trpc.appFeedback.create.useMutation();
  const sent = create.isSuccess;
  const errorMessage = create.error ? appFeedbackSubmitErrorMessage(create.error) : null;

  const submit = () => {
    if (!canSubmitAppFeedback(message) || create.isPending) return;
    create.mutate(buildAppFeedbackCreateInput(request, message));
  };

  return (
    <Modal
      opened
      onClose={() => (create.isPending ? undefined : onClose())}
      title={appFeedbackModalTitle(target.appName)}
      size="md"
      centered
      fullScreen={isMobile}
      data-testid="app-feedback-modal"
    >
      {sent ? (
        <Stack gap="md" data-testid="app-feedback-sent">
          <Text size="sm">{APP_FEEDBACK_SENT_MESSAGE}</Text>
          <Group justify="flex-end">
            <Button onClick={onClose}>Close</Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <Alert
            color="blue"
            variant="light"
            icon={<IconLock size={16} />}
            data-testid="app-feedback-private-notice"
          >
            <Text size="sm">
              <Text span fw={700}>
                Private.
              </Text>{' '}
              {APP_FEEDBACK_PRIVATE_NOTICE}
            </Text>
          </Alert>
          <Textarea
            label="Your feedback"
            placeholder="What's working, what's broken, what you'd like…"
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
            autosize
            minRows={4}
            maxRows={10}
            disabled={create.isPending}
            data-testid="app-feedback-message"
          />
          <Text size="xs" c="dimmed" data-testid="app-feedback-sent-with">
            {appFeedbackSentWithLine(target.appBlockVersion, request.context)}
          </Text>
          {errorMessage && (
            <Alert color="red" variant="light" data-testid="app-feedback-error">
              {errorMessage}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              loading={create.isPending}
              disabled={!canSubmitAppFeedback(message)}
              data-testid="app-feedback-submit"
            >
              Send
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
