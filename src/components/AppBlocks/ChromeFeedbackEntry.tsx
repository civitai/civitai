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
 * developer (their collaborators and moderators read it too). The entry point is a button in the
 * chrome bar itself, beside the ⋮ trigger, on every surface (page host and model slot, desktop
 * bar and compact shell): labelled "Feedback" on a wide bar, icon-only on a narrow one. It used
 * to be a ⋮ menu item, which buried the one action whose whole point is to be reached while the
 * app is in front of you. It hands what it resolved UP to
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
/** The visible text on the wide bar. The accessible name stays the full sentence above. */
export const APP_FEEDBACK_BUTTON_TEXT = 'Feedback';

/** Hover for a pointer, and focus so a keyboard user sees the label too (Mantine: hover only). */
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
  labelled,
  onOpenFeedback,
}: {
  request: AppFeedbackRequest | null;
  /** Show the "Feedback" text beside the icon (wide bar) or the icon alone (narrow bar). */
  labelled: boolean;
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
  return (
    <ChromeFeedbackButtonBody request={entry} labelled={labelled} onOpenFeedback={onOpenFeedback} />
  );
}

function ChromeFeedbackButtonBody({
  request,
  labelled,
  onOpenFeedback,
}: {
  request: AppFeedbackRequest;
  labelled: boolean;
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
  const open = () => onOpenFeedback({ request, appName, appBlockVersion });
  // Both forms are 22px tall (`compact-xs` / ActionIcon `sm`), the bar's resting control height,
  // so neither grows the pinned one-line bar (`CHROME_BAR_PX`). Neither shrinks under a long app
  // name: an ActionIcon has `min-width: var(--ai-size)` and a Button's label does not wrap.
  return (
    <Tooltip label={APP_FEEDBACK_BUTTON_LABEL} withArrow openDelay={300} events={TOOLTIP_EVENTS}>
      {labelled ? (
        // A bare gray icon at the far end of a full-width bar is easy to miss, so the wide bar
        // names it. The aria-label keeps the full meaning and still contains the visible word.
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<IconMessage2 size={14} stroke={1.5} />}
          aria-label={APP_FEEDBACK_BUTTON_LABEL}
          data-testid="app-block-feedback-button"
          data-labelled="true"
          onClick={open}
        >
          {APP_FEEDBACK_BUTTON_TEXT}
        </Button>
      ) : (
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={APP_FEEDBACK_BUTTON_LABEL}
          data-testid="app-block-feedback-button"
          data-labelled="false"
          onClick={open}
        >
          <IconMessage2 size={16} stroke={1.5} />
        </ActionIcon>
      )}
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
