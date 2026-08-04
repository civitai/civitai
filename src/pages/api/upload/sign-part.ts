import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getUploadPartUrl, getUploadS3Client, getUploadBucket } from '~/utils/s3-utils';
import { logToAxiom } from '~/server/logging/client';

// Part URLs from /api/upload expire 12h after the upload starts, which a multi-hour
// transfer of a very large file can outlive. Without this the client's retry replays
// the same expired URL and the upload dies with the bytes already half-uploaded.
const signPart = async (req: NextApiRequest, res: NextApiResponse) => {
  instrumentApiResponse(req, res);
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { bucket, key, uploadId, partNumber, backend } = req.body ?? {};
  if (
    typeof bucket !== 'string' ||
    typeof key !== 'string' ||
    typeof uploadId !== 'string' ||
    !Number.isInteger(partNumber) ||
    partNumber < 1
  ) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  // /api/upload mints keys as `${type}/${userId}/${filename}`. Re-signing is only ever a
  // continuation of one of those, so scope it to the caller's own prefix and to a bucket
  // we actually upload to — otherwise this hands any signed-in user a write URL for an
  // arbitrary object.
  const allowedBuckets = new Set([getUploadBucket('default'), getUploadBucket('b2')]);
  if (key.split('/')[1] !== String(userId) || !allowedBuckets.has(bucket)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  try {
    const s3 = backend === 'b2' ? getUploadS3Client('b2') : null;
    const result = await getUploadPartUrl({ bucket, key, uploadId, partNumber, s3 });
    await logToAxiom({ name: 's3-upload-sign-part', userId, key, uploadId, partNumber, backend });
    res.status(200).json(result);
  } catch (e) {
    const error = e as Error;
    await logToAxiom({
      name: 's3-upload-sign-part-error',
      userId,
      key,
      uploadId,
      partNumber,
      backend,
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  }
};

export default signPart;
