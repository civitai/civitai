import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getMimeTypeFromExt } from '~/shared/constants/mime-types';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getMultipartPutUrl, getImageUploadBackend } from '~/utils/s3-utils';
import { registerMediaLocation } from '~/server/services/storage-resolver';

export default async function imageUploadMultipart(req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });
    const userId = session?.user?.id;
    if (!userId || session.user?.bannedAt || session.user?.muted) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const imageKey = randomUUID();

    const imageMime: string | undefined = req.body.mimeType;
    const fileExt: string | undefined = req.body.filename?.split('.').pop();

    const mimeType = imageMime ?? (fileExt ? getMimeTypeFromExt(fileExt) : undefined);

    const { s3, bucket, backend } = await getImageUploadBackend();
    const result = await getMultipartPutUrl(imageKey, req.body.size, s3, bucket, mimeType);

    // Register in storage-resolver (fire-and-forget)
    registerMediaLocation(imageKey, backend, req.body.size ?? 0);

    res.status(200).json({ ...result, backend });
  } catch (error) {
    const e = error as Error;
    return res.status(500).json({ error: e.message });
  }
}
