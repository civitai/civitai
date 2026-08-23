import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import {
  abortMultipartUpload,
  classifyS3MultipartError,
  completeMultipartUpload,
  getS3Client,
  getUploadS3Client,
  getB2ImageS3Client,
  headObject,
  objectExists,
} from '~/utils/s3-utils';
import { logToAxiom } from '~/server/logging/client';
import { env } from '~/env/server';

/**
 * Timeout budget for the post-completion existence probe. The user has already waited
 * out the whole upload by this point, so a few seconds is invisible — but an UNBOUNDED
 * probe against a degraded backend would turn a finished upload into a hung request,
 * which is strictly worse than the bug this guards.
 *
 * Per `headObject`'s contract this bounds each network ATTEMPT, not wall-clock: the
 * SDK's retry sleep is not abort-aware, so worst case is this budget plus one backoff.
 * An abort lands on `unknown` → the request passes.
 */
const COMPLETE_VERIFY_TIMEOUT_MS = 5_000;

/**
 * What the post-completion probe concluded. 🔴 THREE values, never a boolean.
 *
 * A boolean forces the fail-open case to be reported as one of the other two, and
 * both readings are wrong: counting `indeterminate` as verified asserts we confirmed
 * an object we never saw, and counting it as missing inflates the defect rate with
 * probes that simply could not reach the bucket. Both directions corrupt the very
 * measurement the observe-only rollout below exists to take.
 */
type VerifyVerdict = 'confirmed' | 'missing' | 'indeterminate';

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
    // Resolve the default (R2) client ONCE and reuse it for both the completion and
    // the probe below. Without this the probe builds a SECOND unmemoized S3Client per
    // request on the `default` happy path, where previously one was built per
    // completion. Kept inside the try so an unconfigured environment still lands in
    // the classifier below rather than throwing out of the handler.
    s3 ??= getS3Client();

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
     * One HeadObject closes that gap: the failure surfaces at completion time, as a
     * failed upload the user can see and retry, instead of a row that looks healthy
     * forever. 🔴 Note it does NOT guarantee the bytes are still in hand — the store
     * keeps the File, but `useS3Upload.tsx` sets `file: undefined` on its bailout, so
     * "retry" there means the user re-selecting the file, not an automatic resend.
     *
     * We deliberately trust the probe over the response SHAPE: a present, non-empty
     * object is proof regardless of whether the backend echoed a Location.
     */
    const head = await headObject(bucket, key, s3, {
      abortSignal: AbortSignal.timeout(COMPLETE_VERIFY_TIMEOUT_MS),
    });
    /**
     * 🔴 REJECT ONLY ON WHAT THE BACKEND ACTUALLY ASSERTED.
     *
     * `indeterminate` (the probe threw, timed out, 403'd, or the client wasn't
     * configured) means we could not consult the bucket. That is not evidence of loss,
     * and treating it as loss would let a verification step fail uploads that worked.
     * It is logged and the request passes. Only two shapes are `missing`: the bucket
     * ANSWERED `absent`, or it answered with a definitively ZERO ContentLength.
     * `size: null` is "the backend reported no length", not zero, so it must not trip
     * the size check.
     *
     * NOTE what this can and cannot catch. There is NO trustworthy expected size at
     * this point in the flow: the request body carries only bucket/key/uploadId/parts,
     * the parts manifest carries ETag+PartNumber with no per-part sizes, and the
     * `sizeKb` used downstream is client-supplied and never verified against the
     * bytes. So this catches ABSENT and EMPTY, and cannot catch a short-but-non-zero
     * object. That is not a reason to invent a comparison that looks rigorous and
     * isn't — a present, non-empty object is strictly better evidence than none.
     */
    let verdict: VerifyVerdict;
    if (head.status === 'unknown') verdict = 'indeterminate';
    else if (head.status === 'absent' || head.size === 0) verdict = 'missing';
    else verdict = 'confirmed';

    /**
     * 🔴 OBSERVE-ONLY BY DEFAULT. The probe always runs and always logs; whether a
     * `missing` verdict actually FAILS the request is gated.
     *
     * Rejecting here is a new failure mode on the upload happy path, and there is
     * currently no way to see or stop a false-reject storm: a 422 increments no
     * Prometheus counter, because the http-error instrument returns early below 500.
     * The only signal is this log.
     *
     * The measurement also has to come first on its merits. The known damage — rows
     * pointing at objects that never landed — can only count the PERMANENT class. If a
     * backend can ack a completion before the object is listable, there is also a
     * TRANSIENT class that is observable ONLY from this probe, and it is exactly the
     * population that would be falsely rejected. R2 documents strong read-after-write
     * consistency including multipart; Backblaze's S3-compatible API reference
     * documents no consistency model at all, and its native large-file docs advise
     * re-checking after a finish call that appears to succeed. So on the backend where
     * the incident happened, "acked" and "visible" are not established to be the same
     * instant — and our own premise is that it acked while leaving nothing behind.
     *
     * So: deploy with this off, let the `missing` rate accumulate against the total,
     * then enable it in a second deploy. Flipping it back off is a config change, not
     * a revert.
     *
     * Compared against `true` explicitly: the gate guards a REJECTION, so anything
     * other than an unambiguous opt-in — unset, malformed, a stray string — must land
     * on observe-only rather than on failing uploads. It also keeps the logged field a
     * real boolean instead of `undefined`, which would be indistinguishable from
     * "this build predates the field" when reading the rollout data.
     */
    const enforcing = env.UPLOAD_COMPLETE_VERIFY_ENFORCE === true;

    /**
     * 🔴 DECIDE AND SEND THE RESPONSE BEFORE ANY TELEMETRY. The logging below used to
     * run FIRST, which put three awaited `logToAxiom` calls between a completed upload
     * and the client's answer.
     *
     * On 2026-08-23 Axiom's ingest host went unreachable for 44 minutes. `logToAxiom`
     * awaited it uncontained, so the first of those calls threw AFTER
     * `completeMultipartUpload` had already stored the object — and the browser was told
     * 500. ~5,300 requests, 350 users, every one of them an upload that had in fact
     * succeeded. `@civitai/axiom` now contains and time-boxes that write, so it can no
     * longer throw; this ordering is the half that does not depend on it staying that
     * way, and it also keeps the telemetry budget off the client's latency.
     *
     * The response is a pure function of `verdict` + `enforcing`, so hoisting it changes
     * no status, no header and no body — only when they are written.
     */
    const rejecting = verdict === 'missing' && enforcing;

    if (rejecting) {
      /**
       * Release the multipart session before failing, so a rejected completion does
       * not strand parts. These are the largest objects in the system.
       *
       * Safe in both directions: if the session really is unfinished this frees the
       * parts, and if the completion did finalize an object then Abort answers
       * NoSuchUpload and is a no-op — it cannot delete a finalized object. Guarded
       * because a cleanup failure must never change the response the client gets.
       *
       * 🔴 This bounds the PARTS leak, not every leak. The upload key carries a
       * random token, so the client's retry writes to a DIFFERENT key; an object that
       * becomes visible after we called it absent would sit at the old key with no DB
       * row. That case cannot be cleaned up from here without deleting an object we
       * just concluded does not exist — and it is precisely the population the
       * observe-only phase above exists to measure before rejection is enabled.
       */
      try {
        await abortMultipartUpload(bucket, key, uploadId, s3);
      } catch {
        /* cleanup is best-effort; never let it change the client's outcome */
      }

      /**
       * 422, against this handler's existing taxonomy (409 terminal / 422
       * parts-invalid + no-store / 503 transient + Retry-After / 500 genuine fault).
       *
       * We need the client to retry the UPLOAD, not the completion. 422 is the code
       * that already carries that meaning here — "the request was well formed but the
       * upload STATE isn't; terminal → re-upload" — and, unlike a retryable status,
       * both clients now treat it as final rather than re-POSTing a manifest whose
       * session may already be consumed (each such retry throws NoSuchUpload and gets
       * relabelled "already finalized or aborted", destroying the diagnosis).
       *
       * "Both" is load-bearing and was NOT true before this change: the exemption
       * existed only in s3-upload.store.ts, so useS3Upload.tsx retried a terminal
       * status 4 times. It is now one shared predicate — see isTerminalCompleteStatus.
       *
       * Not 409: terminal, but carries no re-upload meaning. Not 500: this is a
       * storage-state fault, and paging on it as a server bug buries it.
       *
       * 🔴 The status is chosen for retry semantics and log separability, NOT for the
       * message text — neither client reads this body on the completion path, so the
       * user sees the same generic upload-failed copy either way.
       */
      res.setHeader('Cache-Control', 'no-store');
      res.status(422).json({
        error: 'Upload completed but the file was not stored — please re-upload',
      });
    } else {
      res.status(200).json(result.Location);
    }

    /**
     * 🔴 CONTAINED, because this telemetry now runs INSIDE the S3 try/catch but AFTER the
     * response. Without this guard a logging failure unwinds into the `catch (e)` below,
     * where it is classified as an S3 fault, logged as `s3-upload-complete-error`, and
     * answered with a SECOND response — on a request that already succeeded. A test
     * (`telemetry failure cannot change the client response`) caught exactly that while
     * this fix was being written.
     *
     * Swallowing is right here and is not silent: `@civitai/axiom` reports its own ingest
     * failures (`axiom-ingest-failed`), and the stderr/Loki line has already been written
     * by the time anything can throw.
     */
    try {
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
        verifyVerdict: verdict,
        verifyEnforced: enforcing,
      });

      // The fail-open branch gets its OWN event, so the rate at which this guard cannot
      // see the bucket is measurable on its own rather than being folded into either the
      // healthy or the defective count.
      if (verdict === 'indeterminate') {
        await logToAxiom({
          name: 's3-upload-complete-verify-unknown',
          userId,
          type,
          key,
          uploadId,
          backend,
        });
      }

      if (verdict === 'missing') {
        // Distinct event name so this class is alertable on its own rather than hiding
        // inside the generic completion log. `verifyEnforced` separates "we would have
        // rejected this" during the observe-only phase from an actual rejection.
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
          verifyEnforced: enforcing,
        });
      }
    } catch {
      /* contained — see above */
    }

    return;
  } catch (e) {
    const error = e as Error;
    console.error('Upload complete error:', error.message, error.stack);

    /**
     * 🔴 CLASSIFY AND RESPOND BEFORE LOGGING — the `await logToAxiom` below used to sit
     * HERE, above the classifier, and that ordering is what made this entire taxonomy
     * unreachable during the 2026-08-23 Axiom outage.
     *
     * The mechanism, because it is not obvious from either line on its own: when the
     * telemetry await throws, nothing after it runs, so `classifyS3MultipartError` was
     * never called and no branch below could execute. Every fault — including 1,009
     * terminal `NoSuchUpload`s that belong at 409 — left the handler as an unhandled
     * rejection, i.e. a 500. 500 is retryable to both clients, so they retried, and each
     * retry hit an already-consumed session and re-failed. Spanmetrics for the whole
     * 44-minute episode recorded ZERO 409/422/503 on this route: not a rare path, a
     * structurally dead one.
     *
     * A response written from the error classification must therefore never be sequenced
     * behind a side-channel that can fail or stall. The logging moved to the `finally`.
     */
    const errorClass = classifyS3MultipartError(e);
    try {
      if (errorClass === 'not-found') {
        // Already finalized or aborted (double-submit / retry-after-success). Which one
        // decides the client's fate — a finalized upload whose 200 the client never saw
        // must not be reported as a failure, or the bytes are stranded in the bucket with
        // no DB row. Only a genuine miss is terminal.
        //
        // 🔴 The probe's own throw is folded into its `null` (indeterminate) case rather
        // than escaping. `objectExists` already returns `null` when the bucket could not
        // be consulted, and `null` already means 409 here — but a THROWN failure used to
        // escape the handler as a 500 instead, which is the same not-found fault reported
        // as a server bug. That fires exactly when the backend is degraded, i.e. when this
        // path is busiest. Only a definite `true` still yields 200, so nothing is masked
        // in the direction that could strand bytes.
        const exists = await objectExists(bucket, key, s3).catch(() => null);
        if (exists === true) {
          res.status(200).json(null);
        } else {
          // 409 Conflict = terminal state → tells the client to STOP retrying.
          res.status(409).json({ error: 'Upload already finalized or aborted' });
        }
      } else if (errorClass === 'invalid-parts') {
        // The parts manifest the client sent doesn't match what the backend stored
        // (a part upload failed/expired, a stale ETag, or an empty/mis-ordered list) —
        // a B2/S3 400-class fault. 422 Unprocessable Entity = the request was well
        // formed but the upload STATE isn't; terminal → the client must stop retrying
        // this manifest and re-upload. no-store so nothing caches the failure.
        res.setHeader('Cache-Control', 'no-store');
        res.status(422).json({ error: 'Upload parts invalid or incomplete — please re-upload' });
      } else if (errorClass === 'transient') {
        // Retry-able storage-backend blip (S3/B2 5xx, throttle/timing, or network).
        res.setHeader('Retry-After', '2');
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).json({ error: 'Storage temporarily unavailable, please retry' });
      } else {
        // Real server fault → surface loud as a 500 so the upload legitimately fails.
        res.status(500).json({ error });
      }
    } finally {
      // `finally`, not a trailing statement: the event must be recorded whichever branch
      // ran, and — unlike before — it can no longer decide which branch runs. Contained
      // for the same reason as the success path above: nothing about the client's
      // outcome may depend on telemetry.
      try {
        await logToAxiom({
          name: 's3-upload-complete-error',
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
