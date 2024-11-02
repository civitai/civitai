import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { abortMultipartUpload, getS3Client } from '~/utils/s3-utils';
import { logToDb } from '~/utils/logging';
import { UploadType } from '~/server/common/enums';

const upload = async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { bucket, key, type, uploadId } = req.body;
  const s3 = type === UploadType.Image ? getS3Client('image') : undefined;
  const result = await abortMultipartUpload(bucket, key, uploadId, s3);
  await logToDb('s3-upload-abort', { userId, type, key, uploadId });

  res.status(200).json(result);
};

export default upload;
