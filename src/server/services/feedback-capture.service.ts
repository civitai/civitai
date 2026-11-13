import {
  FEEDBACK_CAPTURE_OWNER_ID,
  type FeedbackScreenshotCheck,
} from '@civitai/shared/feedback-capture';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { createImage } from '~/server/services/image.service';
import { keyIssuers, keysIn } from '~/server/services/image-url-ownership';
import { MediaType } from '~/shared/utils/prisma/enums';

/** What became of a report's page capture: its image row, or why there is none. */
export type FeedbackCaptureResult =
  | { screenshotImageId: number }
  | { screenshotCheck: FeedbackScreenshotCheck };

/** Whether the one upload key in `screenshotId` was issued to `reporterId`. */
async function screenshotOwnership(
  screenshotId: string,
  reporterId: number
): Promise<'owner' | FeedbackScreenshotCheck> {
  if (keysIn(screenshotId).length !== 1) return 'unverified';
  const issuers = await keyIssuers({ urls: [screenshotId], userId: reporterId });
  if (issuers.issuedToOthers.length) return 'not-owner';
  if (issuers.tooMany || issuers.unrecorded.length) return 'unverified';
  return 'owner';
}

async function createCapture(feedbackId: number, reporterId: number, screenshotId: string) {
  const ownership = await screenshotOwnership(screenshotId, reporterId);
  if (ownership !== 'owner') return { screenshotCheck: ownership };
  const owner = await dbWrite.user.findUnique({
    where: { id: FEEDBACK_CAPTURE_OWNER_ID },
    select: { id: true },
  });
  if (!owner) return { screenshotCheck: 'unverified' as const };
  const image = await createImage({
    url: screenshotId,
    type: MediaType.image,
    userId: FEEDBACK_CAPTURE_OWNER_ID,
    feedbackCapture: { feedbackId, reporterId },
  });
  return { screenshotImageId: image.id };
}

/**
 * Stores a report's page capture as an image owned by the capture account, so it is scanned and
 * never counts against the reporter, and records the outcome on the report. Behind
 * `feedback-capture-scan`; null when the flag is off or there is no capture. Never throws: the
 * report is already saved.
 */
export async function captureFeedbackScreenshot({
  feedbackId,
  reporterId,
  screenshotId,
}: {
  feedbackId: number;
  reporterId: number;
  screenshotId?: string;
}): Promise<FeedbackCaptureResult | null> {
  if (!screenshotId) return null;
  try {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.FEEDBACK_CAPTURE_SCAN, String(reporterId))))
      return null;
  } catch {
    return null;
  }

  let result: FeedbackCaptureResult;
  try {
    result = await createCapture(feedbackId, reporterId, screenshotId);
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'feedback-capture',
      message: 'Failed to store a feedback page capture',
      feedbackId,
      error: (error as Error).message,
    }).catch(() => undefined);
    result = { screenshotCheck: 'unverified' };
  }

  try {
    await dbWrite.$executeRaw`
      UPDATE "Feedback"
      SET context = COALESCE(context, '{}'::jsonb) || ${JSON.stringify(result)}::jsonb
      WHERE id = ${feedbackId}
    `;
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'feedback-capture',
      message: 'Failed to record a feedback page capture',
      feedbackId,
      error: (error as Error).message,
    }).catch(() => undefined);
  }
  return result;
}
