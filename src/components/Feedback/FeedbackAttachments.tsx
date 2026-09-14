import type { StackProps } from '@mantine/core';
import {
  ActionIcon,
  Button,
  Checkbox,
  FileButton,
  Group,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import { IconPaperclip, IconX } from '@tabler/icons-react';
import type { FeedbackSubmission } from '~/components/Feedback/useFeedbackSubmission';
import { FEEDBACK_IMAGE_MAX_COUNT } from '~/shared/constants/feedback.constants';

type FeedbackAttachmentsProps = { feedback: FeedbackSubmission } & StackProps;

/**
 * What rides along with a report whether or not the reporter does anything.
 *
 * 🔴 THIS EXISTS BECAUSE THE SILENT PAYLOAD GREW. Before the browser-error snapshot, `context`
 * already carried the page path, the `/apps` filters INCLUDING the typed search term, and the Faro
 * session id — none of it disclosed anywhere, while the screenshot (the one thing a reporter would
 * expect to be asked about) was the only opt-in. Adding console and network capture to that same
 * silent payload without saying so is the change that makes the existing gap indefensible, so the
 * line ships in the same commit as the capture rather than as a follow-up.
 *
 * It is a CONSTANT, and it is rendered from the one component both surfaces mount, so the inline
 * prompt and the drawer cannot disclose different things. `FeedbackPrompt` previously disclosed
 * nothing at all and the drawer's own copy claimed console errors were already being collected
 * when they were not — two surfaces, two different wrong answers, which is what one value fixes.
 *
 * Keep it a description of the MECHANISM, not a reassurance about it. If the capture widens, this
 * sentence is part of the diff.
 */
export const FEEDBACK_TELEMETRY_DISCLOSURE =
  'Sent with your report: the page you were on, any filters or search you had set, your browser ' +
  'session id, and the last few errors and failed requests your browser recorded. Web addresses ' +
  'are stored without their query strings. Images are only sent if you attach them above.';

/**
 * The attach / capture controls, shared by every feedback surface so the consent
 * copy and the screenshot preview cannot differ between them. Spacing is left to
 * the caller (`StackProps`), which is the only thing the two surfaces disagree on.
 */
export function FeedbackAttachments({ feedback, ...stackProps }: FeedbackAttachmentsProps) {
  const {
    attachments,
    screenshot,
    screenshotConsent,
    capturing,
    busy,
    canAddMore,
    handleFilesSelected,
    handleRemoveAttachment,
    handleScreenshotConsentChange,
    handleDropScreenshot,
  } = feedback;

  return (
    <Stack gap="xs" {...stackProps}>
      <Group gap="xs" wrap="wrap" align="center">
        <FileButton onChange={handleFilesSelected} accept="image/*" multiple>
          {(props) => (
            <Button
              {...props}
              size="compact-sm"
              radius="xl"
              variant="light"
              leftSection={<IconPaperclip size={14} />}
              disabled={!canAddMore || busy}
            >
              Attach images
            </Button>
          )}
        </FileButton>
        <Text size="xs" c="dimmed">
          {attachments.length} of {FEEDBACK_IMAGE_MAX_COUNT} attached
        </Text>
      </Group>
      {!!attachments.length && (
        <Group gap="xs" wrap="wrap">
          {attachments.map((attachment) => (
            <div key={attachment.key} style={{ position: 'relative' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachment.objectUrl}
                alt={`Attached image ${attachment.file.name}`}
                style={{
                  width: 64,
                  height: 64,
                  objectFit: 'cover',
                  borderRadius: 8,
                  display: 'block',
                }}
              />
              <ActionIcon
                size="xs"
                radius="xl"
                variant="filled"
                color="dark"
                style={{ position: 'absolute', top: -6, right: -6 }}
                aria-label={`Remove attached image ${attachment.file.name}`}
                onClick={() => handleRemoveAttachment(attachment.key)}
              >
                <IconX size={12} />
              </ActionIcon>
            </div>
          ))}
        </Group>
      )}
      <Checkbox
        size="xs"
        checked={screenshotConsent}
        // `busy` subsumes `capturing` (see its definition); kept as one term so the
        // two cannot drift apart again.
        disabled={busy}
        onChange={(event) => void handleScreenshotConsentChange(event.currentTarget.checked)}
        label="Attach a screenshot of this page"
        description="We'll show it to you before anything is sent. Only what's on screen is captured."
      />
      {capturing && (
        <Group gap="xs" align="center">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Capturing the page…
          </Text>
        </Group>
      )}
      {screenshot && (
        <Stack gap={4} align="flex-start">
          <Text size="xs" c="dimmed">
            This is what will be sent:
          </Text>
          <div style={{ position: 'relative' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={screenshot.objectUrl}
              alt="Preview of the page screenshot that will be sent"
              style={{
                maxWidth: 240,
                maxHeight: 160,
                borderRadius: 8,
                display: 'block',
                border: '1px solid var(--mantine-color-default-border)',
              }}
            />
            <ActionIcon
              size="xs"
              radius="xl"
              variant="filled"
              color="dark"
              style={{ position: 'absolute', top: -6, right: -6 }}
              aria-label="Remove the page screenshot"
              onClick={handleDropScreenshot}
            >
              <IconX size={12} />
            </ActionIcon>
          </div>
        </Stack>
      )}
      {/* 🔴 NOT conditional on anything. A disclosure a reporter only sees once they have already
          opened the attachment controls, or only on one of the two surfaces, is not a disclosure.
          See FEEDBACK_TELEMETRY_DISCLOSURE for why it is a shared constant. */}
      <Text size="xs" c="dimmed">
        {FEEDBACK_TELEMETRY_DISCLOSURE}
      </Text>
    </Stack>
  );
}
