import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { UploadType } from '~/server/common/enums';
import { extname } from 'node:path';
import { filenamize, generateToken } from '~/utils/string-helpers';
import { getMultipartPutUrl, getUploadS3Client, getUploadBucket } from '~/utils/s3-utils';
import type { UploadBackend } from '~/utils/s3-utils';
import { env } from '~/env/server';
import { isPreview } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { isFlipt, FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';

const upload = async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { filename: fullFilename } = req.body;
  const ext = extname(fullFilename);
  const filename = filenamize(fullFilename.replace(ext, ''));
  let { type } = req.body;
  if (!type || !Object.values(UploadType).includes(type)) type = UploadType.Default;

  if (env.UPLOAD_PROHIBITED_EXTENSIONS?.includes(ext)) {
    return res.status(400).json({ error: 'File type not allowed' });
  }

  // Determine upload backend: B2 for model uploads when flag is enabled
  let backend: UploadBackend = 'default';
  if (type === UploadType.Model && env.S3_UPLOAD_B2_ENDPOINT) {
    // Force B2 on preview environments; otherwise check Flipt flag
    const useB2 =
      isPreview || (await isFlipt(FLIPT_FEATURE_FLAGS.B2_UPLOAD_DEFAULT, String(userId)));
    if (useB2) {
      backend = 'b2';
    }
  }

  const key = `${type ?? UploadType.Default}/${userId}/${filename}.${generateToken(4)}${ext}`;
  const s3 = backend === 'b2' ? getUploadS3Client('b2') : null;
  const bucket = backend === 'b2' ? getUploadBucket('b2') : null;
  const result = await getMultipartPutUrl(key, req.body.size, s3, bucket);
  await logToAxiom({
    name: 's3-upload',
    userId,
    type,
    filename: fullFilename,
    key,
    uploadId: result.uploadId,
    bucket: result.bucket,
    backend,
  });

  res.status(200).json({ ...result, backend });
};

export default upload;
