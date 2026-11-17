import { isFeedbackCaptureOwner, readFeedbackCaptureStamp } from '@civitai/shared/feedback-capture';
import { dbRead } from '~/server/db/client';

/** What a moderator picks a CSAM report's subject from, for one feedback page capture. */
export type CaptureReportContext = {
  imageId: number;
  feedbackId: number | null;
  reporterId: number | null;
  reporterUsername: string | null;
  /** The page the reporter was on, as their report recorded it. */
  path: string | null;
};

/**
 * The capture `imageId` names, with the report and reporter its server stamp records. Null when the
 * image is not a feedback page capture. The stamp, not a link parameter, decides who the reporter is.
 */
export async function getCaptureReportContext(
  imageId: number
): Promise<CaptureReportContext | null> {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { id: true, userId: true, metadata: true },
  });
  if (!image || !isFeedbackCaptureOwner(image.userId)) return null;

  const { feedbackId, reporterId } = readFeedbackCaptureStamp(image.metadata);

  const [reporter, feedback] = await Promise.all([
    reporterId
      ? dbRead.user.findUnique({ where: { id: reporterId }, select: { username: true } })
      : null,
    feedbackId
      ? dbRead.feedback.findUnique({ where: { id: feedbackId }, select: { context: true } })
      : null,
  ]);
  const path = (feedback?.context as Record<string, unknown> | null)?.path;

  return {
    imageId: image.id,
    feedbackId,
    reporterId,
    reporterUsername: reporter?.username ?? null,
    path: typeof path === 'string' && path ? path : null,
  };
}
