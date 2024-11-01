import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { getMultipartPutUrl, getS3Client } from '~/utils/s3-utils';
import { env } from '~/env/server.mjs';
import { randomUUID } from 'crypto';

const s3Domain = (env.S3_IMAGE_UPLOAD_ENDPOINT ?? env.S3_UPLOAD_ENDPOINT).replace(
  /https?\:\/\//,
  ''
);

export default async function imageUploadMultipart(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt || session.user?.muted) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const imageKey = randomUUID();
  const s3 = getS3Client('image');
  const result = await getMultipartPutUrl(
    imageKey,
    req.body.size,
    s3,
    env.S3_IMAGE_UPLOAD_BUCKET,
    100 * 1024 * 1024 // 100 MB
  );

  if (env.S3_IMAGE_UPLOAD_OVERRIDE) {
    result.urls = result.urls.map((item) => ({
      ...item,
      url: item.url.replace(
        `${env.S3_IMAGE_UPLOAD_BUCKET}.${s3Domain}`,
        env.S3_IMAGE_UPLOAD_OVERRIDE as string
      ),
    }));
  }

  res.status(200).json(result);
}
