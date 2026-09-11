import { useEffect, useRef, useState } from 'react';
import { captureConsentedScreenshot } from '~/components/Feedback/captureScreenshot';
import { selectAttachments } from '~/components/Feedback/selectAttachments';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeedbackArea } from '~/shared/constants/feedback.constants';
import { FEEDBACK_IMAGE_MAX_COUNT } from '~/shared/constants/feedback.constants';
import { getFaroSessionId } from '~/utils/faro/getFaroSessionId';
import { showErrorNotification } from '~/utils/notifications';
import { formatBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/**
 * Ceiling on a file the USER chose, as distinct from `SCREENSHOT_MAX_BYTES`, which
 * bounds the capture this feature generates. Taken from the shared upload constant
 * that nine other upload surfaces in this repo already enforce
 * (ImageDropzone, SimpleImageUpload, ProfileImageUpload, ImageUpload, …), rather
 * than a number invented here — the point is to stop being the one picker that
 * silently accepts a 40-megapixel phone photo at full size, not to introduce a
 * different limit for feedback. Note there is NO server backstop: the presigned PUT
 * from `/api/v1/image-upload` carries no size condition, so this is the only check.
 */
const FEEDBACK_ATTACHMENT_MAX_BYTES = constants.mediaUpload.maxImageFileSize;

/**
 * A file the user has chosen (or a capture they accepted) that has NOT been
 * uploaded yet. Previews come from a local object URL, so nothing leaves the
 * browser until Send is pressed — see the upload-budget note on
 * FEEDBACK_IMAGE_MAX_COUNT.
 */
export type PendingAttachment = { key: string; file: File; objectUrl: string };

let attachmentKeySeq = 0;
const nextAttachmentKey = () => `attachment-${++attachmentKeySeq}`;

const revoke = (objectUrl: string) => {
  try {
    URL.revokeObjectURL(objectUrl);
  } catch {
    // Nothing to do; the URL dies with the document either way.
  }
};

export type UseFeedbackSubmissionArgs = {
  area: FeedbackArea;
  /** Extra detail stored alongside the message so a one-line report is still actionable. */
  context?: CreateFeedbackInput['context'];
  /** The caller's own gate. False means don't ask the server whether the area is collecting. */
  enabled?: boolean;
};

export type FeedbackSubmission = ReturnType<typeof useFeedbackSubmission>;

/**
 * Everything a feedback surface has to get right, in one place: the consent-gated
 * page capture, the object-URL lifecycle, the deferred uploads, and the submit.
 *
 * It exists because there are now two surfaces (the inline `FeedbackPrompt` and the
 * `FeedbackDrawer` behind the support menu) and only one of them can be the place
 * the screenshot-consent rules live. Layout is deliberately NOT here — the two
 * surfaces arrange the same controls differently.
 */
export function useFeedbackSubmission({
  area,
  context,
  enabled = true,
}: UseFeedbackSubmissionArgs) {
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // 🔴 The consent flag for DOM capture. Starts OFF and is only ever set by the
  // user's own click on the checkbox. Nothing else may set it true.
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

  const { data } = trpc.feedback.getArea.useQuery({ area }, { enabled });

  const createFeedback = trpc.feedback.create.useMutation({
    onSuccess: () => setSent(true),
    onError: (error) =>
      showErrorNotification({ title: 'Feedback not sent', error: new Error(error.message) }),
  });

  const handleFilesSelected = (selected: File[] | null) => {
    if (!selected?.length) return;
    const { accepted, rejectedForSize, rejectedForCount } = selectAttachments({
      selected,
      alreadyAttached: attachments.length,
      maxCount: FEEDBACK_IMAGE_MAX_COUNT,
      maxBytes: FEEDBACK_ATTACHMENT_MAX_BYTES,
    });

    // Both rejections are said out loud, and separately. Silently dropping a file
    // looks like the picker failed; collapsing the two reasons into one message
    // sends the user to fix the wrong thing.
    if (rejectedForSize.length)
      showErrorNotification({
        title: 'Image too large',
        error: new Error(
          `${rejectedForSize.map((file) => file.name).join(', ')} — images must be under ` +
            `${formatBytes(FEEDBACK_ATTACHMENT_MAX_BYTES)}.`
        ),
      });
    if (rejectedForCount.length)
      showErrorNotification({
        title: 'Too many images',
        error: new Error(`You can attach up to ${FEEDBACK_IMAGE_MAX_COUNT} images.`),
      });
    if (!accepted.length) return;

    const added = accepted.map((file) => ({
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
   * 🔴 The ONLY path here that can start a capture, and it is reached only from the
   * consent checkbox's own `onChange`. `checked` IS the user's consent.
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

  /** Drop the preview but leave the form usable — the user saw it and said no. */
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

  // 🔴 `capturing` belongs here, not only on the checkbox's own `disabled`. A capture
  // is async, and `handleSubmit` reads `screenshot` — which is still null while it is
  // in flight. Without this, a user who ticks the box, types, and presses Send before
  // the capture resolves gets "Got it, thanks" for a submission with NO screenshot,
  // while the capture completes onto a panel that is already hidden. They believe
  // they attached a screenshot and did not. Blocking Send is the honest resolution:
  // the button is briefly unavailable and says so via its spinner, rather than
  // silently sending something other than what the user assembled.
  const busy = uploading || capturing || createFeedback.isPending;

  return {
    areaEnabled: !!data?.enabled,
    sent,
    message,
    setMessage,
    attachments,
    screenshot,
    screenshotConsent,
    capturing,
    busy,
    canAddMore: attachments.length < FEEDBACK_IMAGE_MAX_COUNT,
    canSubmit: !!message.trim() && !busy,
    handleFilesSelected,
    handleRemoveAttachment,
    handleScreenshotConsentChange,
    handleDropScreenshot,
    handleSubmit,
  };
}
