import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getCustomPutUrl, getImageUploadBackend } from '~/utils/s3-utils';
import { randomUUID } from 'crypto';
import { registerMediaLocation } from '~/server/services/storage-resolver';

export default async function imageUpload(req: NextApiRequest, res: NextApiResponse) {
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

  res.status(200).json({
    id: result.key,
    uploadURL: result.url,
  });
}
