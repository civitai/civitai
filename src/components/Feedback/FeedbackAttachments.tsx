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
    </Stack>
  );
}
