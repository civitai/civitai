// A feedback report's page capture is stored as an `Image` row owned by a system account, never by
// the reporter, so it never counts against them. Shared by the main app (which creates and purges
// captures) and the moderator app (which shows them).
import { nsfwBrowsingLevelsFlag } from './browsing-levels';

/** The system account that owns every feedback page capture. Created by a hand-applied migration. */
export const FEEDBACK_CAPTURE_OWNER_ID = -2;
export const FEEDBACK_CAPTURE_OWNER_USERNAME = 'civitai-feedback-captures';

/**
 * The capture account is never a subject or the target of an account action: a capture can show
 * any account's content, so acting on its owner acts on nobody.
 */
export const FEEDBACK_CAPTURE_OWNER_REFUSAL =
  'This is the system account that holds feedback page captures; it cannot be the subject of this action. A capture shows content from another account: act on the image, or name that account.';

/** Shown wherever the capture account appears as if it were a user. */
export const FEEDBACK_CAPTURE_ACCOUNT_NOTE =
  "System account for feedback page captures. Each image it owns is a screenshot a reporter attached to a feedback report, and can show any account's content: act on the image, or on the account whose content it shows.";

/** A capture's owner stands for no one: never notified, and its reporter is not told either. */
export function isFeedbackCaptureOwner(userId: unknown): boolean {
  return Number(userId) === FEEDBACK_CAPTURE_OWNER_ID;
}

/** Captures older than this are deleted by the daily purge. */
export const FEEDBACK_CAPTURE_RETENTION_DAYS = 30;

/**
 * `Image.metadata` key naming the report a capture belongs to. Server-owned: only the feedback submit
 * writes it, and every client-supplied copy is dropped.
 */
export const FEEDBACK_CAPTURE_METADATA_KEY = 'feedbackCapture';
export type FeedbackCaptureMetadata = { feedbackId: number; reporterId: number };

const positiveId = (value: unknown) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** The report and reporter a capture's `Image.metadata` stamp names; null for any it lacks. */
export function readFeedbackCaptureStamp(metadata: unknown): {
  feedbackId: number | null;
  reporterId: number | null;
} {
  const stamp = (metadata as Record<string, unknown> | null | undefined)?.[
    FEEDBACK_CAPTURE_METADATA_KEY
  ] as Partial<FeedbackCaptureMetadata> | null | undefined;
  return { feedbackId: positiveId(stamp?.feedbackId), reporterId: positiveId(stamp?.reporterId) };
}

/**
 * Why a report's `screenshotId` has no capture row: the upload was not issued to the reporter, or
 * that could not be confirmed (including the capture account missing).
 */
export const FEEDBACK_SCREENSHOT_CHECKS = ['not-owner', 'unverified'] as const;
export type FeedbackScreenshotCheck = (typeof FEEDBACK_SCREENSHOT_CHECKS)[number];

export type FeedbackCaptureImage = {
  userId: number;
  ingestion: string;
  nsfwLevel: number;
  needsReview: string | null;
  blockedFor: string | null;
  poi: boolean | null;
  minor: boolean | null;
  tosViolation: boolean | null;
};

/**
 * How a moderator sees a report's page capture:
 *  - `show`: scanned, SFW and unflagged.
 *  - `blur`: not checked, still scanning, flagged or above SFW; a moderator may reveal it.
 *  - `hide`: not the reporter's upload, or blocked by the scan.
 *  - `hide-locked`: hidden with no way to reveal it.
 *  - `expired`: the capture was deleted after the retention period.
 *  - `none`: the report has no page capture.
 */
export type FeedbackCaptureView = 'show' | 'blur' | 'hide' | 'hide-locked' | 'expired' | 'none';

export function feedbackCaptureView({
  screenshotId,
  screenshotImageId,
  screenshotCheck,
  image,
}: {
  screenshotId?: string | null;
  screenshotImageId?: number | null;
  screenshotCheck?: string | null;
  /** The `Image` row `screenshotImageId` names, or null when there is none. */
  image: FeedbackCaptureImage | null;
}): FeedbackCaptureView {
  if (!screenshotId) return 'none';
  if (screenshotCheck === 'not-owner') return 'hide';
  if (screenshotImageId == null) return 'blur';
  if (!image) return 'expired';
  if (image.userId !== FEEDBACK_CAPTURE_OWNER_ID) return 'hide';
  if (image.needsReview === 'csam' || image.blockedFor === 'CSAM' || image.minor === true)
    return 'hide-locked';
  if (image.ingestion === 'Blocked') return 'hide';
  return isFeedbackCaptureReady(image) ? 'show' : 'blur';
}

/**
 * Scanned, unflagged and SFW: the same `ready` as the App Blocks upload gate
 * (`classifyBlockImageUploadScan`), which a main-app test pins this to.
 */
export function isFeedbackCaptureReady(image: Omit<FeedbackCaptureImage, 'userId' | 'blockedFor'>) {
  if (image.ingestion !== 'Scanned') return false;
  if (
    image.needsReview != null ||
    image.poi === true ||
    image.minor === true ||
    image.tosViolation === true
  )
    return false;
  return (image.nsfwLevel & nsfwBrowsingLevelsFlag) === 0;
}
