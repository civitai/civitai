import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getCustomPutUrl, getS3Client } from '~/utils/s3-utils';
import { env } from '~/env/server';
import { randomUUID } from 'crypto';

const s3Domain = (env.S3_IMAGE_UPLOAD_ENDPOINT ?? env.S3_UPLOAD_ENDPOINT).replace(
  /https?\:\/\//,
  ''
);

export default async function imageUpload(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const imageKey = randomUUID();
  const s3 = getS3Client('image');
  const result = await getCustomPutUrl(env.S3_IMAGE_UPLOAD_BUCKET, imageKey, s3);
  if (env.S3_IMAGE_UPLOAD_OVERRIDE) {
    result.url = result.url.replace(
      `${env.S3_IMAGE_UPLOAD_BUCKET}.${s3Domain}`,
      env.S3_IMAGE_UPLOAD_OVERRIDE
    );
  }

  res.status(200).json({
    id: result.key,
    uploadURL: result.url,
  });
}
