import {
  ActionIcon,
  Button,
  Checkbox,
  Divider,
  FileButton,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { IconAlertTriangle, IconPaperclip, IconX } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { captureConsentedScreenshot } from '~/components/Feedback/captureScreenshot';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeedbackArea } from '~/shared/constants/feedback.constants';
import {
  FEEDBACK_IMAGE_MAX_COUNT,
  FEEDBACK_MESSAGE_MAX_LENGTH,
} from '~/shared/constants/feedback.constants';
import { getFaroSessionId } from '~/utils/faro/getFaroSessionId';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const cardStyle: CSSProperties = {
  background: 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
  boxShadow: 'light-dark(0 1px 3px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.5))',
};

const dismissKey = (area: FeedbackArea) => `feedback-dismissed-${area}`;

// Storage access throws outright in a sandboxed iframe or with storage disabled,
// and this renders inside the feed — an unguarded read would take the whole page
// to the error boundary to save one banner.
function readDismissed(area: FeedbackArea) {
  try {
    return window.sessionStorage.getItem(dismissKey(area)) === 'true';
  } catch {
    return false;
  }
}

function writeDismissed(area: FeedbackArea) {
  try {
    window.sessionStorage.setItem(dismissKey(area), 'true');
  } catch {
    // Dismissal is then per-mount rather than per-tab.
  }
}

/**
 * A file the user has chosen (or a capture they accepted) that has NOT been
 * uploaded yet. Previews come from a local object URL, so nothing leaves the
 * browser until Send is pressed — see the upload-budget note on
 * FEEDBACK_IMAGE_MAX_COUNT.
 */
type PendingAttachment = { key: string; file: File; objectUrl: string };

let attachmentKeySeq = 0;
const nextAttachmentKey = () => `attachment-${++attachmentKeySeq}`;

const revoke = (objectUrl: string) => {
  try {
    URL.revokeObjectURL(objectUrl);
  } catch {
    // Nothing to do; the URL dies with the document either way.
  }
};

type FeedbackPromptProps = {
  area: FeedbackArea;
  notice: string;
  placeholder?: string;
  /** Extra detail stored alongside the message so a one-line report is still actionable. */
  context?: CreateFeedbackInput['context'];
  /** Caller's own condition — e.g. "BitDex actually served this page". */
  active?: boolean;
};

export function FeedbackPrompt({
  area,
  notice,
  placeholder = 'What looked wrong?',
  context,
  active = true,
}: FeedbackPromptProps) {
  const currentUser = useCurrentUser();
  const [dismissed, setDismissed] = useState(() => readDismissed(area));
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // 🔴 The consent flag for DOM capture. Starts OFF and is only ever set by the
  // user's own click on the checkbox below. Nothing else may set it true.
  const [screenshotConsent, setScreenshotConsent] = useState(false);
  const [screenshot, setScreenshot] = useState<PendingAttachment | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);

  const { uploadToCF } = useCFImageUpload();

  // Object URLs outlive React state unless revoked. A ref (not the state itself)
  // because this must run on unmount with whatever was live at that moment, and a
  // cleanup closed over `attachments` would see the value from its own render.
  const liveObjectUrls = useRef<Set<string>>(new Set());
  useEffect(() => {
    const urls = liveObjectUrls.current;
    return () => {
      urls.forEach(revoke);
      urls.clear();
    };
  }, []);

  const trackObjectUrl = (objectUrl: string) => {
    liveObjectUrls.current.add(objectUrl);
    return objectUrl;
  };
  const releaseObjectUrl = (objectUrl: string) => {
    liveObjectUrls.current.delete(objectUrl);
    revoke(objectUrl);
  };

  const enabled = active && !!currentUser && !dismissed;
  const { data } = trpc.feedback.getArea.useQuery({ area }, { enabled });

  const createFeedback = trpc.feedback.create.useMutation({
    onSuccess: () => setSent(true),
    onError: (error) =>
      showErrorNotification({ title: 'Feedback not sent', error: new Error(error.message) }),
  });

  if (!enabled || !data?.enabled) return null;

  const handleClose = () => {
    if (open && !sent) {
      setOpen(false);
      return;
    }
    writeDismissed(area);
    setDismissed(true);
  };

  const handleFilesSelected = (selected: File[] | null) => {
    if (!selected?.length) return;
    const remaining = FEEDBACK_IMAGE_MAX_COUNT - attachments.length;
    if (remaining <= 0) return;
    // Silently taking the first N would look like the extras failed to attach, so
    // say the cap out loud and still take what fits.
    if (selected.length > remaining)
      showErrorNotification({
        title: 'Too many images',
        error: new Error(`You can attach up to ${FEEDBACK_IMAGE_MAX_COUNT} images.`),
      });
    const added = selected.slice(0, remaining).map((file) => ({
      key: nextAttachmentKey(),
      file,
      objectUrl: trackObjectUrl(URL.createObjectURL(file)),
    }));
    setAttachments((current) => [...current, ...added]);
  };

  const handleRemoveAttachment = (key: string) => {
    setAttachments((current) => {
      const match = current.find((x) => x.key === key);
      if (match) releaseObjectUrl(match.objectUrl);
      return current.filter((x) => x.key !== key);
    });
  };

  const clearScreenshot = () => {
    setScreenshot((current) => {
      if (current) releaseObjectUrl(current.objectUrl);
      return null;
    });
  };

  /**
   * 🔴 The ONLY path in this component that can start a capture, and it is reached
   * only from the checkbox's own `onChange`. `checked` IS the user's consent.
   *
   * Honest note on the two layers: by the time `captureConsentedScreenshot` is
   * called, the `!checked` branch has already returned, so the argument is always
   * `true` — the module's own guard is redundant *from this call site*. It is not
   * redundant in general (it is the guard for every future caller, and it is what
   * `captureScreenshot.test.ts` pins). The guarantee THIS function carries is a
   * different one: no other code path here calls capture at all.
   */
  const handleScreenshotConsentChange = async (checked: boolean) => {
    setScreenshotConsent(checked);
    if (!checked) {
      clearScreenshot();
      return;
    }
    setCapturing(true);
    try {
      const file = await captureConsentedScreenshot({ consented: checked });
      if (!file) {
        // Defensive: `null` is the module's "no consent" answer, which this call
        // site cannot currently produce. Handled rather than asserted away so a
        // future refactor that loosens the argument fails visibly (the checkbox
        // snaps back) instead of silently rendering an empty preview.
        setScreenshotConsent(false);
        return;
      }
      setScreenshot({
        key: nextAttachmentKey(),
        file,
        objectUrl: trackObjectUrl(URL.createObjectURL(file)),
      });
    } catch (error) {
      // A failed capture must not look like a silently attached one.
      setScreenshotConsent(false);
      showErrorNotification({
        title: 'Could not capture the page',
        error: error instanceof Error ? error : new Error('Screenshot failed'),
      });
    } finally {
      setCapturing(false);
    }
  };

  /** Drop the preview but leave the prompt usable — the user saw it and said no. */
  const handleDropScreenshot = () => {
    clearScreenshot();
    setScreenshotConsent(false);
  };

  const handleSubmit = async () => {
    setUploading(true);
    try {
      // Uploads happen HERE, not at attach time, so nothing is spent on a
      // submission the user abandons.
      const images: string[] = [];
      for (const attachment of attachments) {
        const { id } = await uploadToCF(attachment.file);
        images.push(id);
      }
      const screenshotId = screenshot ? (await uploadToCF(screenshot.file)).id : undefined;

      // Read at submit time rather than at mount: Faro may finish starting between
      // the two. Undefined whenever Faro is not running at all — dev/test/preview,
      // or a session that blocked it — and the field is then simply omitted, which
      // is the ordinary case and never blocks the submission.
      const sessionId = getFaroSessionId();

      createFeedback.mutate({
        area,
        message: message.trim(),
        context: {
          ...context,
          ...(images.length ? { images } : {}),
          ...(screenshotId ? { screenshotId } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      });
    } catch (error) {
      showErrorNotification({
        title: 'Could not attach your images',
        error: error instanceof Error ? error : new Error('Upload failed'),
      });
    } finally {
      setUploading(false);
    }
  };

  const busy = uploading || createFeedback.isPending;
  const canAddMore = attachments.length < FEEDBACK_IMAGE_MAX_COUNT;

  return (
    <Paper withBorder radius="md" style={cardStyle}>
      <Group p="sm" justify="space-between" align="center" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" align="center" style={{ flex: 1, minWidth: 0 }}>
          <IconAlertTriangle size={16} className="text-yellow-500" style={{ flexShrink: 0 }} />
          <Text size="sm">{sent ? `Got it, thanks. We'll take a look.` : notice}</Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {!open && !sent && (
            <Button size="compact-sm" radius="xl" variant="light" onClick={() => setOpen(true)}>
              Give feedback
            </Button>
          )}
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={handleClose}
            aria-label={open && !sent ? 'Cancel feedback' : 'Dismiss'}
          >
            <IconX size={16} />
          </ActionIcon>
        </Group>
      </Group>
      {open && !sent && (
        <>
          <Divider />
          <Group p="sm" gap="xs" align="flex-start" wrap="nowrap">
            <Textarea
              style={{ flex: 1, minWidth: 0 }}
              value={message}
              onChange={(event) => setMessage(event.currentTarget.value)}
              placeholder={placeholder}
              maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
              autosize
              minRows={1}
              maxRows={6}
              autoFocus
              styles={{
                input: {
                  background:
                    'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))',
                },
              }}
            />
            <Button
              // `sm` is 36px, matching a one-row `sm` Textarea; compact does not.
              size="sm"
              radius="xl"
              style={{ flexShrink: 0 }}
              disabled={!message.trim() || busy}
              // Mantine's disabled fill is near-invisible on this card surface.
              classNames={{
                root: 'data-[disabled]:!bg-blue-6 data-[disabled]:!text-white data-[disabled]:!opacity-50',
              }}
              loading={busy}
              onClick={handleSubmit}
            >
              Send feedback
            </Button>
          </Group>
          <Stack px="sm" pb="sm" gap="xs">
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
              disabled={busy || capturing}
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
        </>
      )}
    </Paper>
  );
}
