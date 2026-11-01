import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getCustomPutUrl, getImageUploadBackend } from '~/utils/s3-utils';
import { randomUUID } from 'crypto';
import { registerMediaLocation } from '~/server/services/storage-resolver';
import { trackImageUpload } from '~/server/services/image-upload-action.service';
import { recordUploadKeyOwner } from '~/server/services/image-url-ownership';

export default async function imageUpload(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const imageKey = randomUUID();
  const { s3, bucket, backend } = await getImageUploadBackend();
  const result = await getCustomPutUrl(bucket, imageKey, s3);

  // Register in storage-resolver (fire-and-forget)
  registerMediaLocation(imageKey, backend, 0);
  trackImageUpload(req, res, result.key);
  await recordUploadKeyOwner(result.key, userId);

  res.status(200).json({
    id: result.key,
    uploadURL: result.url,
  });
}
