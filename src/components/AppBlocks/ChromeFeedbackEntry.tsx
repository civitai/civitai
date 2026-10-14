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
import { IconMessage2 } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';

import { MobileMenuDrawer } from '~/components/Drawer/MobileMenuDrawer';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useVisualViewportBottomInset } from '~/hooks/useVisualViewportBottomInset';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { FEEDBACK_MESSAGE_MAX_LENGTH } from '~/shared/constants/feedback.constants';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { AppFeedbackRequest } from './appFeedbackChrome';
import type { BlockHostSurface } from './blockInitFragmentGate';
import {
  APP_FEEDBACK_SENT_MESSAGE,
  APP_FEEDBACK_SENT_TOAST_MS,
  appFeedbackCharacterCounter,
  appFeedbackEntryRequest,
  appFeedbackModalTitle,
  appFeedbackSubmitErrorMessage,
  buildAppFeedbackCreateInput,
  canSubmitAppFeedback,
  isAppFeedbackSubmitShortcut,
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
  hostSurface,
  labelled,
  onOpenFeedback,
}: {
  request: AppFeedbackRequest | null;
  /** The mounting host. Omitted, or a surface that offers no feedback → renders nothing. */
  hostSurface: BlockHostSurface | undefined;
  /** Show the "Feedback" text beside the icon (wide bar) or the icon alone (narrow bar). */
  labelled: boolean;
  onOpenFeedback: (target: AppFeedbackModalTarget) => void;
}) {
  const currentUser = useCurrentUser();
  const features = useOptionalFeatureFlags();
  const entry = appFeedbackEntryRequest({
    isSignedIn: !!currentUser,
    hasStoreAccess: hasAppsStoreAccess(features),
    hostSurface,
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
  const { appName } = data;
  const open = () => onOpenFeedback({ request, appName });
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

/**
 * Desktop: how far the dialog sits above the bottom of the viewport. It is anchored there rather
 * than centred so it does not cover the middle of the app the feedback is about. Mantine applies
 * the same offset at the top, which only caps the dialog's height.
 */
export const APP_FEEDBACK_DESKTOP_BOTTOM_OFFSET = '10dvh';
/**
 * Mobile: the bottom sheet's scrim. Lighter than Mantine's default 0.6 so the app stays readable
 * behind the sheet while the user describes it; the sheet itself stays opaque.
 */
export const APP_FEEDBACK_SHEET_SCRIM_OPACITY = 0.25;
/** Desktop-width dialog with an on-screen keyboard up: the gap kept above the keyboard. */
const APP_FEEDBACK_KEYBOARD_GAP_PX = 8;

export function AppFeedbackModal({
  target,
  onClose,
}: {
  target: AppFeedbackModalTarget;
  onClose: () => void;
}) {
  // Same viewport rule as `ReviewListingModal`: a modal IS the viewport.
  const isMobile = useIsMobile({ type: 'media' });
  // Both renderings sit at the bottom of the viewport, so both are under an on-screen keyboard:
  // the wide one too, on a tablet or a phone held sideways. 0 with no keyboard, and also on a
  // pinch-zoomed page or for a gap under 100px, which the hook does not count as a keyboard.
  const keyboardInset = useVisualViewportBottomInset();
  // Set in the same tick as the send, which `create.isPending` is not: it only turns true on the
  // next render, so two keydowns or clicks delivered before that render would both get through.
  const sending = useRef(false);
  const { request } = target;
  const [message, setMessage] = useState('');
  // Not `useFeedbackSubmission`: that hook attaches host-page diagnostics (session id, console
  // and network errors) to every submit, and none of that is collected for app feedback.
  const create = trpc.appFeedback.create.useMutation({
    // A sent message needs no second screen: close and confirm with a toast. An error has no
    // such path — it renders inline below and the dialog stays open with the text kept.
    onSuccess: () => {
      showSuccessNotification({
        message: APP_FEEDBACK_SENT_MESSAGE,
        autoClose: APP_FEEDBACK_SENT_TOAST_MS,
      });
      onClose();
    },
  });
  const errorMessage = create.error ? appFeedbackSubmitErrorMessage(create.error) : null;
  const counter = appFeedbackCharacterCounter(message.length);

  const submit = () => {
    if (!canSubmitAppFeedback(message) || sending.current) return;
    sending.current = true;
    create.mutate(buildAppFeedbackCreateInput(request, message), {
      // Released on an error so the kept text can be sent again; success closes the dialog.
      onSettled: () => {
        sending.current = false;
      },
    });
  };
  // Esc, the close button and the scrim all come through here; none may close mid-submit.
  const close = () => (create.isPending ? undefined : onClose());
  const title = appFeedbackModalTitle(target.appName);

  const body = (
    <Stack gap="sm">
      <Stack gap={4}>
        <Textarea
          label="Your feedback"
          placeholder="What's working, what's broken, what you'd like…"
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          onKeyDown={(e) => {
            const shortcut = isAppFeedbackSubmitShortcut({
              key: e.key,
              ctrlKey: e.ctrlKey,
              metaKey: e.metaKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.nativeEvent.keyCode,
            });
            if (!shortcut) return;
            e.preventDefault();
            submit();
          }}
          maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
          autosize
          minRows={4}
          maxRows={10}
          disabled={create.isPending}
          // Mantine's focus trap focuses this on open instead of the header's close button.
          data-autofocus
          data-testid="app-feedback-message"
        />
        {counter && (
          <Text size="xs" c="dimmed" ta="right" data-testid="app-feedback-counter">
            {counter}
          </Text>
        )}
      </Stack>
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
  );

  return isMobile ? (
    <AppFeedbackSheet title={title} onClose={close} keyboardInset={keyboardInset}>
      {body}
    </AppFeedbackSheet>
  ) : (
    <Modal
      opened
      onClose={close}
      title={title}
      size="md"
      yOffset={APP_FEEDBACK_DESKTOP_BOTTOM_OFFSET}
      // Bottom-anchored: Mantine's inner box is a flex row whose cross-axis alignment is the
      // dialog's vertical position (`centered` sets it to `center`, the default is the top).
      // With a keyboard up, that box ends at the keyboard's top edge instead of the viewport's,
      // and the 10dvh offsets shrink to a small gap so the dialog keeps what height is left;
      // its `maxHeight` is then the box's, and the dialog scrolls inside it.
      // Written as a literal `styles={{ inner: { … } }}` on purpose: the safe-area sweep in
      // `viewport-fit-cover.test.ts` reads that shape, and this padding must stay in its sight.
      styles={{
        inner: {
          alignItems: 'flex-end',
          ...(keyboardInset > 0 && {
            bottom: keyboardInset,
            paddingTop: `max(${APP_FEEDBACK_KEYBOARD_GAP_PX}px, var(--safe-area-inset-top, 0px))`,
            paddingBottom: APP_FEEDBACK_KEYBOARD_GAP_PX,
          }),
        },
        content: { maxHeight: keyboardInset > 0 ? '100%' : undefined },
      }}
      data-testid="app-feedback-modal"
    >
      {body}
    </Modal>
  );
}

/**
 * The phone rendering: the site's bottom sheet (`MobileMenuDrawer` — `Drawer position="bottom"`,
 * sized to its content, at the sheet z-index tier), changed for a form typed into on a phone:
 *
 * - `inner`'s `bottom` is raised by the on-screen keyboard's height, so the textarea and Send stay
 *   above the keyboard. The content's `maxHeight` is therefore a share of that raised box rather
 *   than of the viewport (the wrapper's `90dvh` would run under the keyboard).
 * - A lighter scrim ({@link APP_FEEDBACK_SHEET_SCRIM_OPACITY}).
 * - Tighter header and body: the header drops Mantine's 60px minimum height and the body's sides
 *   are 12px, because vertical room is what the keyboard takes. A slot passed to
 *   `MobileMenuDrawer` replaces the wrapper's whole slot, so each one set here restates the
 *   wrapper's values it keeps.
 *
 * Unchanged: the bottom safe-area inset is paid by the global `.mantine-Drawer-content` rule in
 * `src/styles/globals.css`; neither this nor the wrapper sets the `content` slot's padding.
 */
function AppFeedbackSheet({
  title,
  onClose,
  keyboardInset,
  children,
}: {
  title: string;
  onClose: () => void;
  keyboardInset: number;
  children: ReactNode;
}) {
  return (
    <MobileMenuDrawer
      opened
      onClose={onClose}
      title={title}
      overlayProps={{ backgroundOpacity: APP_FEEDBACK_SHEET_SCRIM_OPACITY }}
      styles={{
        inner: { bottom: keyboardInset },
        content: { height: 'auto', maxHeight: '90%' },
        header: { padding: '8px 8px 8px 12px', minHeight: 0 },
        body: { overflowY: 'auto', padding: '0 12px 12px' },
      }}
      data-testid="app-feedback-modal"
    >
      {children}
    </MobileMenuDrawer>
  );
}
