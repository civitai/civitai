import { Anchor, Button, Drawer, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { FeedbackAttachments } from '~/components/Feedback/FeedbackAttachments';
import { useFeedbackSubmission } from '~/components/Feedback/useFeedbackSubmission';
import { SUPPORT_LINKS } from '~/components/Support/support.constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_PATH_MAX_LENGTH,
  SITE_BUG_REPORT_AREA,
} from '~/shared/constants/feedback.constants';

/**
 * "Report a bug" from the support menu.
 *
 * Deliberately the SAME submission path as the inline `FeedbackPrompt` — one
 * `useFeedbackSubmission`, one `feedback.create`, one `Feedback` table — because the
 * point of this entry point is that a report carries the Faro session id and the
 * screenshot, which a support ticket does not.
 */
export default function FeedbackDrawer() {
  const dialog = useDialogContext();
  // `media`, not the default container query: a Drawer is positioned against the
  // viewport, and the container one also makes this component unmountable outside a
  // ContainerProvider — which a dialog opened from the footer has no reason to need.
  const mobile = useIsMobile({ type: 'media' });
  const router = useRouter();

  const feedback = useFeedbackSubmission({
    area: SITE_BUG_REPORT_AREA,
    // 🔴 THE ROUTE ONLY — the query string is cut off deliberately. This entry point
    // is reachable from the footer on every route, including ones that carry a secret
    // in the URL (`/redeem-code?code=…`, `/payment/coinbase?key=…`), and `context` is
    // a JSONB column that triage reads. Storing `asPath` whole would write a live
    // redeemable code into it, permanently, without ever telling the reporter. The
    // inline /apps prompt already splits this way: it reports a bare pathname and
    // sends its search term through the bounded `filters` field.
    context: { path: router.asPath.split(/[?#]/)[0].slice(0, FEEDBACK_PATH_MAX_LENGTH) },
  });
  const { sent, message, setMessage, busy, canSubmit, handleSubmit } = feedback;

  return (
    <Drawer
      // 🔴 KEEPS THE PANEL OUT OF ITS OWN SCREENSHOT. `captureConsentedScreenshot`
      // draws `document.body`, and this Drawer portals into it — so without this the
      // capture a reporter opts into is 480px of this form plus the page dimmed
      // behind the overlay, which is the one artifact that makes a report better
      // than a ticket. html2canvas-pro's cloner skips any element carrying this
      // attribute and its whole subtree; it sits on the Drawer ROOT so the overlay
      // goes with it. Pinned by FeedbackDrawer.browser.test.tsx.
      data-html2canvas-ignore
      position={mobile ? 'bottom' : 'right'}
      size={mobile ? '100dvh' : 480}
      shadow="lg"
      transitionProps={{ transition: mobile ? 'slide-up' : 'slide-left' }}
      title={
        <Title order={4} className="font-semibold">
          Report a bug
        </Title>
      }
      {...dialog}
    >
      {sent ? (
        <Stack gap="sm" align="flex-start">
          <IconCircleCheck size={32} className="text-green-6" />
          <Text size="sm">
            Got it, thanks. We&apos;ll take a look — your browser session is attached, so we can see
            what happened without having to ask.
          </Text>
          <Button radius="xl" onClick={dialog.onClose}>
            Done
          </Button>
        </Stack>
      ) : !feedback.areaEnabled ? (
        // The menu already hides this entry when the area is off, so reaching here
        // means the flag went off between the click and the render. Say so, and hand
        // over the ticket portal rather than a dead form.
        <Text size="sm">
          Bug reports aren&apos;t being collected here right now. You can still reach us through the{' '}
          <Anchor
            href={SUPPORT_LINKS.portal}
            target="_blank"
            rel="nofollow noreferrer"
            td="underline"
          >
            Support Portal
          </Anchor>
          .
        </Text>
      ) : (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Tell us what went wrong. We attach your browser session automatically, so console errors
            come with the report.
          </Text>
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            placeholder="What were you doing, and what happened instead?"
            maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
            autosize
            minRows={5}
            maxRows={12}
            autoFocus
          />
          <FeedbackAttachments feedback={feedback} />
          <Button radius="xl" fullWidth disabled={!canSubmit} loading={busy} onClick={handleSubmit}>
            Send report
          </Button>
        </Stack>
      )}
    </Drawer>
  );
}
