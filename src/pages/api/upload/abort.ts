import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import {
  abortMultipartUpload,
  classifyS3MultipartError,
  getUploadS3Client,
  getB2ImageS3Client,
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

  const { bucket, key, type, uploadId, backend } = req.body;
  try {
    let s3;
    if (backend === 'backblaze') {
      s3 = getB2ImageS3Client();
    } else if (backend === 'b2') {
      s3 = getUploadS3Client('b2');
    }
    const result = await abortMultipartUpload(bucket, key, uploadId, s3);
    // 🔴 RESPOND BEFORE LOGGING — see the note in the catch block below, and the same
    // note in ./complete.ts. Telemetry must not sit between the work and the answer.
    res.status(200).json(result);
    // 🔴 CONTAINED: this now runs after the response but still inside the S3 try, so an
    // uncontained throw would unwind into the catch below and re-answer a request that
    // already succeeded. Not silent — @civitai/axiom reports its own ingest failures.
    try {
      await logToAxiom({ name: 's3-upload-abort', userId, type, key, uploadId, backend });
    } catch {
      /* contained — see above */
    }
  } catch (e) {
    const error = e as Error;
    console.error('Upload abort error:', error.message, error.stack);

    /**
     * 🔴 CLASSIFY AND RESPOND BEFORE LOGGING. The `await logToAxiom` below used to sit
     * here, ahead of the classifier, so when Axiom's ingest host went unreachable on
     * 2026-08-23 this whole 204/422/503 taxonomy was unreachable with it and every abort
     * left as a 500 — 92 sampled failures on a route that normally emits none, on top of
     * the completions that had already failed and caused the aborts. Full mechanism in
     * ./complete.ts's catch block.
     */
    const errorClass = classifyS3MultipartError(e);
    try {
      if (errorClass === 'not-found') {
        // Aborting an upload that is already gone (completed/aborted) is IDEMPOTENT:
        // the desired end-state — the upload no longer exists — already holds, so this
        // is a success, not a conflict. 204 stops the client retry loop cleanly. (The
        // sole caller, s3-upload.store.ts, fire-and-forgets abort and ignores the
        // response, so 204 is safe and terminal.)
        res.status(204).end();
      } else if (errorClass === 'invalid-parts') {
        // A parts-manifest fault (400-class) surfaced on the abort path — terminal, the
        // client must stop retrying and re-upload. 422 Unprocessable Entity mirrors the
        // complete handler. no-store so nothing caches the failure. (The sole caller
        // fire-and-forgets abort and ignores the body, so the status alone is safe.)
        res.setHeader('Cache-Control', 'no-store');
        res.status(422).json({ error: 'Upload parts invalid or incomplete — please re-upload' });
      } else if (errorClass === 'transient') {
        // Retry-able storage-backend blip (S3/B2 5xx, throttle/timing, or network).
        res.setHeader('Retry-After', '2');
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).json({ error: 'Storage temporarily unavailable, please retry' });
      } else {
        // Real server fault → surface loud as a 500.
        res.status(500).json({ error });
      }
    } finally {
      try {
        await logToAxiom({
          name: 's3-upload-abort-error',
          userId,
          type,
          key,
          uploadId,
          backend,
          error: error.message,
          errorClass,
        });
      } catch {
        /* contained — see the success path */
      }
    }
  }
};

export default upload;
