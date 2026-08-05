import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import {
  classifyS3MultipartError,
  completeMultipartUpload,
  getUploadS3Client,
  getB2ImageS3Client,
  objectExists,
} from '~/utils/s3-utils';
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

  const { bucket, key, type, uploadId, parts, backend } = req.body;
  let s3;
  if (backend === 'backblaze') {
    s3 = getB2ImageS3Client();
  } else if (backend === 'b2') {
    s3 = getUploadS3Client('b2');
  }
  try {
    const result = await completeMultipartUpload(bucket, key, uploadId, parts, s3);
    await logToAxiom({ name: 's3-upload-complete', userId, type, key, uploadId, backend });

    res.status(200).json(result.Location);
  } catch (e) {
    const error = e as Error;
    console.error('Upload complete error:', error.message, error.stack);
    await logToAxiom({
      name: 's3-upload-complete-error',
      userId,
      type,
      key,
      uploadId,
      backend,
      error: error.message,
    });

    // Classify the S3 error so a client/state fault or a transient storage blip is
    // NOT mis-reported as a raw 500 (which the client then retries → amplification).
    const errorClass = classifyS3MultipartError(e);
    if (errorClass === 'not-found') {
      // Already finalized or aborted (double-submit / retry-after-success). Which one
      // decides the client's fate — a finalized upload whose 200 the client never saw
      // must not be reported as a failure, or the bytes are stranded in the bucket with
      // no DB row. Only a genuine miss is terminal.
      const exists = await objectExists(bucket, key, s3);
      if (exists === true) {
        res.status(200).json(null);
        return;
      }
      // 409 Conflict = terminal state → tells the client to STOP retrying.
      res.status(409).json({ error: 'Upload already finalized or aborted' });
      return;
    }
    if (errorClass === 'invalid-parts') {
      // The parts manifest the client sent doesn't match what the backend stored
      // (a part upload failed/expired, a stale ETag, or an empty/mis-ordered list) —
      // a B2/S3 400-class fault. 422 Unprocessable Entity = the request was well
      // formed but the upload STATE isn't; terminal → the client must stop retrying
      // this manifest and re-upload. no-store so nothing caches the failure.
      res.setHeader('Cache-Control', 'no-store');
      res.status(422).json({ error: 'Upload parts invalid or incomplete — please re-upload' });
      return;
    }
    if (errorClass === 'transient') {
      // Retry-able storage-backend blip (S3/B2 5xx, throttle/timing, or network).
      res.setHeader('Retry-After', '2');
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: 'Storage temporarily unavailable, please retry' });
      return;
    }
    // Real server fault → surface loud as a 500 so the upload legitimately fails.
    res.status(500).json({ error });
  }
};

export default upload;
