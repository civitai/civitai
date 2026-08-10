import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import {
  classifyS3MultipartError,
  completeMultipartUpload,
  getUploadS3Client,
  getB2ImageS3Client,
  headObject,
  objectExists,
} from '~/utils/s3-utils';
import { logToAxiom } from '~/server/logging/client';

/**
 * Wall-clock budget for the post-completion existence probe. The user has already
 * waited out the whole upload by this point, so a few seconds is invisible — but an
 * UNBOUNDED probe against a degraded backend would turn a finished upload into a
 * hung request, which is strictly worse than the bug this guards. Per `headObject`'s
 * contract this bounds each network attempt, not wall-clock: worst case is the budget
 * plus one SDK backoff, and an abort lands on `unknown` → fail open.
 */
const COMPLETE_VERIFY_TIMEOUT_MS = 5_000;

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

    /**
     * 🔴 A NON-THROWING COMPLETION IS NOT PROOF OF A STORED OBJECT — so go look.
     *
     * S3 documents that CompleteMultipartUpload "can contain either a success or an
     * error" and that an error "might be embedded in the 200 OK response". In
     * production a completion resolved as successful, the file row was written 472 ms
     * later, and the storage backend still lists that multipart session as unfinished
     * with NO object. Nothing ever re-verified, so the row became permanent and
     * indistinguishable from a healthy one, and the bytes are unrecoverable — the
     * browser had already dropped them.
     *
     * One HeadObject closes that gap while the client still holds the file and can
     * re-upload. We deliberately trust the probe over the response SHAPE: a present,
     * non-empty object is proof regardless of whether the backend echoed a Location.
     */
    const head = await headObject(bucket, key, s3, {
      abortSignal: AbortSignal.timeout(COMPLETE_VERIFY_TIMEOUT_MS),
    });
    /**
     * 🔴 FAIL OPEN, deliberately, and only on what the backend actually asserted.
     *
     * `unknown` (the probe threw, timed out, 403'd, or the client wasn't configured)
     * means we could not consult the bucket — that is not evidence of loss, and
     * treating it as loss would let a verification step fail uploads that worked. It
     * is logged and passes. Only two verdicts reject: the bucket answered `absent`,
     * or it answered with a definitively ZERO ContentLength. `size: null` is "the
     * backend reported no length", not zero, so it must not trip the size check.
     *
     * NOTE what this can and cannot catch. There is NO trustworthy expected size at
     * this point in the flow: the request body carries only bucket/key/uploadId/parts,
     * the parts manifest carries ETag+PartNumber with no per-part sizes, and the
     * `sizeKb` used downstream is client-supplied and never verified against the
     * bytes. So this catches ABSENT and EMPTY, and cannot catch a short-but-non-zero
     * object. That is not a reason to invent a comparison that looks rigorous and
     * isn't — a present, non-empty object is strictly better evidence than none.
     */
    const objectMissing =
      head.status === 'absent' || (head.status === 'present' && head.size === 0);

    // Log the SHAPE of the completion, not just that it happened, now including the
    // probe's verdict — so a silently-empty completion is distinguishable from a
    // healthy one in the log, which is exactly what the incident lacked.
    // partCount also catches a truncated manifest.
    await logToAxiom({
      name: 's3-upload-complete',
      userId,
      type,
      key,
      uploadId,
      backend,
      partCount: Array.isArray(parts) ? parts.length : null,
      location: result?.Location ?? null,
      etag: result?.ETag ?? null,
      objectStatus: head.status,
      objectSize: head.status === 'present' ? head.size : null,
      objectVerified: !objectMissing,
    });

    if (objectMissing) {
      // Distinct event name so this class is alertable on its own rather than hiding
      // inside the generic completion log.
      await logToAxiom({
        name: 's3-upload-complete-unverified',
        userId,
        type,
        key,
        uploadId,
        backend,
        partCount: Array.isArray(parts) ? parts.length : null,
        location: result?.Location ?? null,
        etag: result?.ETag ?? null,
        objectStatus: head.status,
        objectSize: head.status === 'present' ? head.size : null,
      });

      /**
       * 422, against this handler's existing taxonomy (409 terminal / 422 parts-invalid
       * + no-store / 503 transient + Retry-After / 500 genuine fault).
       *
       * We need the client to retry the UPLOAD, not the completion — and 422 is the
       * code that already means exactly that here: "the request was well formed but
       * the upload STATE isn't; terminal → the client must stop retrying this manifest
       * and re-upload." The client store treats 409 and 422 as terminal and everything
       * else as retry-the-completion, then surfaces any non-ok as a failed upload row
       * while the browser still holds the File.
       *
       * Not 503: re-sending the same manifest cannot be better founded than the call
       * the backend already acknowledged, so its three retries end at the same failed
       * row having cost three more completions and three more probes. Worse, if the
       * first completion did consume the session, each retry now throws NoSuchUpload
       * and lands in the `not-found` branch, relabelling a silent-loss event as
       * "already finalized or aborted" — destroying the diagnosis. Not 409: that tells
       * the client to stop with no instruction to re-upload. Not 500: this is a
       * storage-state fault, and paging on it as a server bug buries it.
       */
      res.setHeader('Cache-Control', 'no-store');
      res.status(422).json({
        error: 'Upload completed but the file was not stored — please re-upload',
      });
      return;
    }

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
