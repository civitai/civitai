import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { getCustomPutUrl } from '~/utils/s3-utils';
import { env } from '~/env/server.mjs';
import { randomUUID } from 'crypto';

export default async function imageUpload(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const imageKey = randomUUID();
  const result = await getCustomPutUrl(env.S3_IMAGE_UPLOAD_BUCKET, imageKey);

  res.status(200).json({
    id: result.key,
    uploadURL: result.url,
  });
}
