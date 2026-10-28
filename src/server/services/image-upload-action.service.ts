import type { NextApiRequest, NextApiResponse } from 'next';
import { clickhouse, Tracker } from '~/server/clickhouse/client';
import { escapeClickhouseString } from '~/server/clickhouse/escape';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

/** How long before an image row was created its upload key may have been minted. */
const UPLOAD_LOOKBACK_HOURS = 24;
/** Clock skew allowed between the app server that minted the key and the one that made the row. */
const UPLOAD_SKEW_HOURS = 1;

/**
 * Records that the requesting user was handed image upload key `key`, with the request's IP.
 * Fire-and-forget: a tracking failure never fails the upload.
 */
export function trackImageUpload(req: NextApiRequest, res: NextApiResponse, key: string) {
  new Tracker(req, res).action({ type: 'ImageUpload', details: { key } }).catch((e) =>
    logToAxiom({
      type: 'error',
      name: 'image-upload-action',
      message: 'Failed to track image upload',
      error: (e as Error).message,
    })
  );
}

/** Shown with a report's IP events: post-creation and upload-request IPs share the Upload event. */
export const UPLOAD_REQUEST_IP_NOTE =
  'Upload IPs are either the address that created the post containing the image or the address that requested the image upload.';

const chTime = (d: Date) => `parseDateTimeBestEffort('${d.toISOString()}')`;

/**
 * The IP that requested each image's upload key, for `userId`'s images among `imageIds`. Matched
 * on the key that became `Image.url`; an image created without a client upload has none.
 */
export async function getImageUploadIpEvents({
  userId,
  imageIds,
}: {
  userId: number;
  imageIds: number[];
}) {
  if (!clickhouse || !imageIds.length) return [];
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, url: true, createdAt: true },
  });
  if (!images.length) return [];

  const idByKey = new Map(images.map((i) => [i.url, i.id]));
  const created = images.map((i) => i.createdAt.getTime());
  const from = new Date(Math.min(...created) - UPLOAD_LOOKBACK_HOURS * 3_600_000);
  const to = new Date(Math.max(...created) + UPLOAD_SKEW_HOURS * 3_600_000);
  const keys = [...idByKey.keys()].map((k) => `'${escapeClickhouseString(k)}'`).join(',');

  const rows = await clickhouse.$query<{ ip: string; key: string; time: string }>(`
    SELECT ip, JSONExtractString(details, 'key') AS key, time
    FROM actions
    WHERE type = 'ImageUpload' AND userId = ${Number(userId)}
      AND time BETWEEN ${chTime(from)} AND ${chTime(to)}
      AND key IN (${keys})
  `);

  return rows.flatMap(({ key, ip, time }) => {
    const id = idByKey.get(key);
    if (id === undefined) return [];
    return [
      { ip, time, type: 'Upload' as const, details: { type: 'image-upload-request' as const, id } },
    ];
  });
}
