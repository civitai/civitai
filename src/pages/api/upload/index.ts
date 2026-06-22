import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { UploadType } from '~/server/common/enums';
import { extname } from 'node:path';
import { filenamize, generateToken } from '~/utils/string-helpers';
import { getMultipartPutUrl, getUploadS3Client, getUploadBucket } from '~/utils/s3-utils';
import type { UploadBackend } from '~/utils/s3-utils';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

const upload = async (req: NextApiRequest, res: NextApiResponse) => {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
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

  // Determine upload backend: B2 for model/training uploads when the B2
  // endpoint is configured (no Flipt flag — see below).
  let backend: UploadBackend = 'default';
  if (type === UploadType.Model && env.S3_UPLOAD_B2_ENDPOINT) {
    // Model files always route to B2 when the endpoint is configured. The
    // b2-upload-default Flipt flag was used for gradual rollout and is now
    // globally enabled. Removing the flag dependency prevents silent S3
    // fallback when Flipt initialization fails (matches the training path).
    backend = 'b2';
  } else if (
    (type === UploadType.TrainingImages || type === UploadType.TrainingImagesTemp) &&
    env.S3_UPLOAD_B2_ENDPOINT
  ) {
    // Always route training data to B2. The b2-training-upload Flipt flag was used
    // for gradual rollout and is now globally enabled. Removing the flag dependency
    // prevents silent R2 fallback when Flipt initialization fails.
    backend = 'b2';
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
