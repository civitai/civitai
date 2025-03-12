import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { completeMultipartUpload, getS3Client } from '~/utils/s3-utils';
import { UploadType } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';

const upload = async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { bucket, key, type, uploadId, parts } = req.body;
  try {
    const s3 = type === UploadType.Image ? getS3Client('image') : undefined;
    const result = await completeMultipartUpload(bucket, key, uploadId, parts, s3);
    await logToAxiom({ name: 's3-upload-complete', userId, type, key, uploadId });

    res.status(200).json(result.Location);
  } catch (e) {
    const error = e as Error;
    res.status(500).json({ error });
  }
};

export default upload;
