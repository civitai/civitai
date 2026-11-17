import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getApiAuthSession } from '~/server/auth/api-auth-session';
import { getCustomPutUrl, getImageUploadBackend } from '~/utils/s3-utils';
import { randomUUID } from 'crypto';
import { registerMediaLocation } from '~/server/services/storage-resolver';
import { trackImageUpload } from '~/server/services/image-upload-action.service';
import {
  recordUploadKeyOwner,
  withholdUnrecordedUploadKey,
} from '~/server/services/image-url-ownership';

export default async function imageUpload(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  const session = await getApiAuthSession({ req, res }, { whenBanned: 'refuse' });
  if (session === false) return;
  const userId = session?.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const imageKey = randomUUID();
  // Recorded before the key is presigned, so a refusal (when on) hands out no usable key.
  if (withholdUnrecordedUploadKey(res, await recordUploadKeyOwner(imageKey, userId))) return;
  const { s3, bucket, backend } = await getImageUploadBackend();
  const result = await getCustomPutUrl(bucket, imageKey, s3);

  // Register in storage-resolver (fire-and-forget)
  registerMediaLocation(imageKey, backend, 0);
  trackImageUpload(req, res, result.key, userId);

  res.status(200).json({
    id: result.key,
    uploadURL: result.url,
  });
}
