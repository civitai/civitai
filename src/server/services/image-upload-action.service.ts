import type { NextApiRequest, NextApiResponse } from 'next';
import { clickhouse, Tracker } from '~/server/clickhouse/client';
import { escapeClickhouseString } from '~/server/clickhouse/escape';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { recordUploadKeyOwner } from '~/server/services/image-url-ownership';
import { isFeedbackCaptureOwner, readFeedbackCaptureStamp } from '@civitai/shared/feedback-capture';

/** How long before an image row was created its upload key may have been minted. */
const UPLOAD_LOOKBACK_HOURS = 24;
/** Clock skew allowed between the app server that minted the key and the one that made the row. */
const UPLOAD_SKEW_HOURS = 1;

/**
 * Records that the requesting user was handed image upload key `key`, with the request's IP.
 * Fire-and-forget: a tracking failure never fails the upload.
 */
export function trackImageUpload(req: NextApiRequest, res: NextApiResponse, key: string) {
  new Tracker(req, res).imageUploadRequest(key).catch((e) =>
    logToAxiom({
      type: 'error',
      name: 'image-upload-action',
      message: 'Failed to track image upload',
      error: (e as Error).message,
    })
  );
}

/**
 * Records an upload key the server minted itself for `userId`, in the issue record and the upload
 * request log, as a client upload is. `tracker` is the request's, for its IP. Never throws.
 */
export async function recordMintedUploadKey(
  key: string,
  userId: number,
  tracker: Tracker = new Tracker()
) {
  await recordUploadKeyOwner(key, userId);
  Promise.resolve()
    .then(() => tracker.imageUploadRequest(key, userId))
    .catch((e) =>
      logToAxiom({
        type: 'error',
        name: 'image-upload-action',
        message: 'Failed to track minted upload key',
        error: (e as Error).message,
      })
    );
}

/** Shown with a report's IP events: post-creation and upload-request IPs share the Upload event. */
export const UPLOAD_REQUEST_IP_NOTE =
  "Upload IP addresses are either the address that created the post containing the image or the address that requested the image's upload.";

/** Shown with a report's IP events when one is a feedback page capture's upload. */
export const FEEDBACK_CAPTURE_UPLOAD_IP_NOTE =
  "One or more upload IP addresses come from a page capture this user submitted: a screenshot of a Civitai page that this user attached to a feedback report sent to Civitai. Each such address is the one that requested that screenshot's upload.";

const chTime = (d: Date) => `parseDateTimeBestEffort('${d.toISOString()}')`;

/** The reporter a feedback page capture's stamp names, or null for any other image. */
const captureReporterId = (image: { userId: number; metadata: unknown }) =>
  isFeedbackCaptureOwner(image.userId) ? readFeedbackCaptureStamp(image.metadata).reporterId : null;

/**
 * The IP that requested each image's upload key, for `userId`'s images among `imageIds`. Matched
 * on the key that became `Image.url`; an image created without a client upload has none.
 *
 * A feedback page capture's key was requested by its reporter, so its IP is `userId`'s only when
 * `userId` is that reporter, and is then marked as a capture's upload. Otherwise it is left out.
 */
export async function getImageUploadIpEvents({
  userId,
  imageIds,
}: {
  userId: number;
  imageIds: number[];
}) {
  // No user, no match: rows a failed session lookup wrote carry userId 0.
  if (!clickhouse || !userId || !imageIds.length) return [];
  const found = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, url: true, createdAt: true, userId: true, metadata: true },
  });
  const captureIds = new Set<number>();
  const images = found.filter((image) => {
    if (!isFeedbackCaptureOwner(image.userId)) return true;
    if (captureReporterId(image) !== Number(userId)) return false;
    captureIds.add(image.id);
    return true;
  });
  if (!images.length) return [];

  const idByKey = new Map(images.map((i) => [i.url, i.id]));
  const created = images.map((i) => i.createdAt.getTime());
  const from = new Date(Math.min(...created) - UPLOAD_LOOKBACK_HOURS * 3_600_000);
  const to = new Date(Math.max(...created) + UPLOAD_SKEW_HOURS * 3_600_000);
  const keys = [...idByKey.keys()].map((k) => `'${escapeClickhouseString(k)}'`).join(',');

  const rows = await clickhouse.$query<{ ip: string; key: string; time: string }>(`
    SELECT ip, key, time
    FROM imageUploadRequests
    WHERE userId = ${Number(userId)}
      AND time BETWEEN ${chTime(from)} AND ${chTime(to)}
      AND key IN (${keys})
  `);

  return rows.flatMap(({ key, ip, time }) => {
    const id = idByKey.get(key);
    if (id === undefined) return [];
    const type = captureIds.has(id)
      ? ('feedback-capture-upload' as const)
      : ('image-upload-request' as const);
    return [{ ip, time, type: 'Upload' as const, details: { type, id } }];
  });
}
