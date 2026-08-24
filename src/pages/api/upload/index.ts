import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { UploadType } from '~/server/common/enums';
import { extname } from 'node:path';
import { filenamize, generateToken } from '~/utils/string-helpers';
import {
  getMultipartPutUrl,
  getUploadS3Client,
  getUploadBucket,
  getUploadChunkSize,
} from '~/utils/s3-utils';
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

  /**
   * 🔴 This handler had NO try/catch and issued its telemetry BEFORE its response, which
   * is the worst pairing of the two: `await logToAxiom` sat between a successfully created
   * multipart session and the 200 that hands the client its presigned part URLs, and any
   * throw there escaped as an unhandled rejection — a 500 with nothing logged anywhere.
   *
   * That is how a telemetry outage took this route down on 2026-08-23 (56 sampled 500s,
   * against a normal baseline of zero) while the S3 backend was healthy the whole time.
   * `@civitai/axiom` now contains that write; the ordering and the catch here are the
   * parts that hold regardless.
   */
  try {
    const result = await getMultipartPutUrl(
      key,
      req.body.size,
      s3,
      bucket,
      undefined,
      getUploadChunkSize(req.body.size)
    );

    res.status(200).json({ ...result, backend });

    // 🔴 CONTAINED: after the response, but still inside the try — an uncontained throw
    // would land in the catch below and answer a successful request with a 500.
    try {
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
    } catch {
      /* contained — @civitai/axiom reports its own ingest failures */
    }
  } catch (e) {
    const error = e as Error;
    console.error('Upload create error:', error.message, error.stack);

    /**
     * A STATIC body, never the error's own text. Two gates shaped this line and both are
     * worth recording, because the obvious versions fail one or the other:
     *
     *  - `{ error: error.message }` puts driver-derived text on the wire and lands this
     *    route on `rest-error-envelope-ledger`'s offender list. The ledger caught it.
     *  - `handleEndpointError(res, e)` is the sanctioned envelope and would be the right
     *    answer in general — but importing `~/server/utils/endpoint-helpers` here pulls
     *    `pgDb` → `kyselyDb` into this route's module graph, which broke
     *    `upload-backend.test.ts` at IMPORT time (reported as `Tests no tests`, not as a
     *    failure). Not worth a new graph edge on a hotfix for a body no client reads.
     *
     * No multipart classification: unlike ./complete.ts and ./abort.ts there is no
     * existing upload session to be in a terminal state about, so every failure here is a
     * genuine create-side fault. The diagnosable detail goes to the log below, not the wire.
     */
    res.status(500).json({ error: 'Failed to start upload' });

    // The event that makes a create failure diagnosable — key/backend/filename plus the
    // real message. Contained for the same reason as the success path.
    try {
      await logToAxiom({
        name: 's3-upload-create-error',
        userId,
        type,
        filename: fullFilename,
        key,
        backend,
        error: error.message,
      });
    } catch {
      /* contained — see the success path */
    }
  }
};

export default upload;
