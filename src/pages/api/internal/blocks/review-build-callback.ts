import { createHmac, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { isAppBlocksPipelineEnabled } from '~/server/services/app-blocks-flag';
import {
  triggerApplyReview,
  waitForApplyJob,
  waitForReviewHostReachable,
} from '~/server/services/blocks/apps-pipeline.service';
import {
  markReviewPreviewState,
  parseReviewDetail,
} from '~/server/services/blocks/publish-request.service';

/**
 * POST /api/internal/blocks/review-build-callback  (MOD REVIEW SANDBOX, #2831)
 *
 * The review Tekton PipelineRun's finally task → civitai-web, once the REVIEW
 * build has succeeded (image pushed to ghcr.io) or failed. Mirrors the
 * production build-callback exactly:
 *   1. Verify HMAC signature (BLOCK_BUILD_CALLBACK_SECRET, with the optional
 *      _NEXT rotation secret).
 *   2. Honour the pipeline kill-switch flag (503 when dark).
 *   3. Bind the accepted imageRef to the REVIEW image (app-block-review-<slug>:<sha>).
 *   4. On success → create the review apply Job, advance the pending request's
 *      preview state to deploying then live (after the Job succeeds).
 *   5. On failure → flip the preview state to failed.
 *
 * The production build-callback is left UNCHANGED; this is an additive parallel
 * lane for review previews only.
 */

// HMAC needs the exact bytes Tekton hashed — read the raw stream ourselves.
export const config = {
  api: { bodyParser: false },
};

const MAX_BODY_BYTES = 8 * 1024;

async function readRawBody(req: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('payload too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

type CallbackBody = {
  mode?: string;
  slug?: string;
  sha?: string;
  publishRequestId?: string;
  imageRef?: string;
  status?: string;
  ts?: unknown;
};

const TS_TOLERANCE_SECONDS = 300;

/** Pure replay-freshness check on the HMAC-bound `ts` (enforce-if-present).
 *  Exported so the skew window is unit-tested without driving the handler. */
export function checkCallbackTimestamp(
  ts: unknown,
  nowSec: number = Math.floor(Date.now() / 1000)
): { ok: true } | { ok: false; reason: string } {
  if (ts === undefined || ts === null) return { ok: true };
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return { ok: false, reason: 'ts present but not a finite number' };
  }
  if (Math.abs(nowSec - ts) > TS_TOLERANCE_SECONDS) {
    return { ok: false, reason: `ts skew ${Math.abs(nowSec - ts)}s exceeds ${TS_TOLERANCE_SECONDS}s` };
  }
  return { ok: true };
}

function safeEqualHex(a: string, b: string): boolean {
  const A = Buffer.from(a, 'hex');
  const B = Buffer.from(b, 'hex');
  if (A.length === 0 || A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

/** Dual-secret HMAC verify (current + optional _NEXT), no short-circuit so
 *  timing can't leak which secret matched. Identical contract to the production
 *  build-callback's verifySignature. */
export function verifySignature(rawBody: Buffer, header: unknown): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  const provided = header.replace(/^sha256=/, '');
  const secrets = [env.BLOCK_BUILD_CALLBACK_SECRET, env.BLOCK_BUILD_CALLBACK_SECRET_NEXT].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  if (secrets.length === 0) return false;
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (safeEqualHex(provided, expected)) matched = true;
  }
  return matched;
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PUBREQ_RE = /^pubreq_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The review image the review pipeline pushes for a (slug, sha). DISTINCT from
 *  the production `app-block-<slug>` image so a review build can never deploy a
 *  production image, and vice versa. */
export function expectedReviewImageRef(slug: string, sha: string): string {
  return `ghcr.io/civitai/app-block-review-${slug}:${sha}`;
}

// Replay guard parity with the production build-callback (#2831). A captured
// signature-valid review callback could be replayed to re-run the review apply
// Job (which deletes + restarts the in-flight review Deployment). Dedup the
// review apply path on (publishRequestId, sha) with the redis client's atomic
// `setNxKeepTtlWithEx` primitive (a single Lua SET NX + EXPIRE returning a typed
// boolean — true = newly set). Keyed on publishRequestId (not appBlockId — a
// PENDING request has no appBlockId yet) + the review sha. Complementary to the
// HMAC-bound `ts` freshness check above: the `ts` window bounds replay to ±300s
// without Redis; this dedups concurrent/duplicate authentic callbacks for the
// same review.
//
// TTL must outlast the whole first attempt: the mark is set before
// triggerApplyReview (two k8s calls, ~60s of 30s-timeouts) and waitForApplyJob
// runs a 6m budget — worst case ~7m. 10m so the key can't expire mid-apply.
// Legitimate same-sha retries are NOT suppressed: the apply-trigger catch frees
// the slot on a Job-creation failure, and the watcher frees it on a definitive
// apply failure; the TTL is only the backstop for the can't-clear cases
// (apply 'timeout' where the Job may still run, or a watcher-crash/pod-restart).
const REVIEW_APPLY_DEDUP_TTL_SECONDS = 10 * 60;
function reviewApplyDedupKey(publishRequestId: string, sha: string): string {
  // Reuse the block rate-limit key family (same convention as the production
  // build-callback's apply dedup key).
  return `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:review-apply:${publishRequestId}:${sha}`;
}
async function markReviewApplyTriggered(publishRequestId: string, sha: string): Promise<boolean> {
  try {
    // true = newly set (first time → apply); false = key already present (replay).
    return await redis.setNxKeepTtlWithEx(
      reviewApplyDedupKey(publishRequestId, sha) as never,
      '1',
      REVIEW_APPLY_DEDUP_TTL_SECONDS
    );
  } catch {
    // Fail OPEN (mirrors the production build-callback): a Redis incident must
    // not block a real review preview. The HMAC secret + imageRef↔slug/sha
    // binding + the `ts` window already bound the blast radius.
    return true;
  }
}
async function clearReviewApplyMark(publishRequestId: string, sha: string): Promise<void> {
  // Free the dedup slot after a definitive apply failure so a same-sha retry
  // isn't suppressed within the TTL window. Best-effort; the TTL is the backstop.
  try {
    await redis.del(reviewApplyDedupKey(publishRequestId, sha) as never);
  } catch {
    // swallow — the TTL will release the slot regardless.
  }
}

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }

  if (!verifySignature(rawBody, req.headers['x-appblocks-signature'])) {
    res.status(401).json({ error: 'Bad signature' });
    return;
  }

  // Pipeline kill-switch — same global flag the production build-callback uses.
  if (!(await isAppBlocksPipelineEnabled())) {
    res.status(503).json({ error: 'Apps are not enabled' });
    return;
  }

  let body: CallbackBody;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as CallbackBody;
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  if (body.mode !== 'review') {
    res.status(400).json({ error: 'mode must be "review"' });
    return;
  }
  if (!body.slug || !SLUG_RE.test(body.slug)) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  if (!body.sha || !SHA_RE.test(body.sha)) {
    res.status(400).json({ error: 'Invalid sha' });
    return;
  }
  if (!body.publishRequestId || !PUBREQ_RE.test(body.publishRequestId)) {
    res.status(400).json({ error: 'Invalid publishRequestId' });
    return;
  }
  // Bind the accepted imageRef to the REVIEW image for THIS slug + sha.
  if (!body.imageRef || body.imageRef !== expectedReviewImageRef(body.slug, body.sha)) {
    res.status(400).json({ error: 'imageRef does not match review slug/sha' });
    return;
  }

  const tsCheck = checkCallbackTimestamp(body.ts);
  if (!tsCheck.ok) {
    res.status(401).json({ error: 'Stale or invalid timestamp' });
    return;
  }

  // Preserve the sha/host/url detail already on the row (previewRequest stamped
  // it) so the failure/deploy updates don't drop the URL the UI shows. Read it
  // best-effort; on any error fall back to a minimal detail.
  let baseDetail = { sha: body.sha } as ReturnType<typeof parseReviewDetail>;
  // If the preview is no longer active by the time the build finishes, do NOT
  // resurrect it. A mod can TEAR DOWN a preview mid-build (teardownPreview clears
  // deployState→null but leaves status='pending'), or the request may have been
  // approved/rejected. Without this guard the success callback would re-write
  // preview-live AND re-create the review Deployment/Service/IngressRoute in k8s
  // (silently refilling a cap slot with a detail-less zombie). Abort only on a
  // POSITIVE read; an unreadable row falls through to existing behavior (the
  // markReviewPreviewState requireActivePreview guard below is the backstop).
  let previewNoLongerActive = false;
  try {
    const { dbRead } = await import('~/server/db/client');
    const row = await dbRead.appBlockPublishRequest.findUnique({
      where: { id: body.publishRequestId },
      select: { deployDetail: true, status: true, deployState: true },
    });
    baseDetail = { ...parseReviewDetail(row?.deployDetail), sha: body.sha };
    if (row && !(row.status === 'pending' && (row.deployState ?? '').startsWith('preview-'))) {
      previewNoLongerActive = true;
    }
  } catch {
    /* fall back to the minimal detail */
  }

  if (previewNoLongerActive) {
    res.status(200).json({
      ok: true,
      applied: false,
      reason: 'preview no longer active (torn down or decided)',
    });
    return;
  }

  const succeeded = (body.status ?? '').toLowerCase() === 'succeeded';
  if (!succeeded) {
    await markReviewPreviewState(
      body.publishRequestId,
      'preview-failed',
      { ...baseDetail, error: `review build ${String(body.status ?? 'failed').slice(0, 60)}` },
      { requireActivePreview: true }
    );
    res.status(200).json({ ok: true, applied: false, reason: 'review build failed' });
    return;
  }

  // Replay guard (#2831, parity with the production build-callback): only run the
  // review apply path once per (publishRequestId, sha) per window. A replayed
  // success callback short-circuits here before re-triggering the review apply Job
  // (which would delete + restart the in-flight review Deployment).
  if (!(await markReviewApplyTriggered(body.publishRequestId, body.sha))) {
    res
      .status(200)
      .json({ ok: true, applied: false, reason: 'duplicate callback (replay-guarded)' });
    return;
  }

  await markReviewPreviewState(body.publishRequestId, 'preview-deploying', baseDetail, {
    requireActivePreview: true,
  });

  let applyJob: { name: string };
  try {
    applyJob = await triggerApplyReview({
      slug: body.slug,
      sha: body.sha,
      publishRequestId: body.publishRequestId,
      imageRef: body.imageRef,
    });
  } catch (e) {
    // Job creation failed — no watcher will run to free the dedup mark, so free
    // it here or a transient k8s hiccup would wedge same-sha retries for the full
    // TTL (symmetrical with the watcher's clear-on-failed below).
    await clearReviewApplyMark(body.publishRequestId, body.sha);
    await markReviewPreviewState(
      body.publishRequestId,
      'preview-failed',
      { ...baseDetail, error: `review apply trigger failed: ${String(e).slice(0, 80)}` },
      { requireActivePreview: true }
    );
    res.status(500).json({ error: 'Review apply trigger failed', detail: String(e).slice(0, 240) });
    return;
  }

  // Respond 200 to Tekton immediately; watch the apply Job async + flip the
  // preview state to live/failed in the background (same shape as the production
  // build-callback's fire-and-forget watcher).
  res.status(200).json({ ok: true, applied: true, jobName: applyJob.name });

  void watchReviewApplyJob({
    publishRequestId: body.publishRequestId,
    sha: body.sha,
    jobName: applyJob.name,
    baseDetail,
  });
});

// Exported for the watcher unit tests (the handler returns 200 to Tekton before
// this runs fire-and-forget, so it can't be observed through the HTTP response).
export async function watchReviewApplyJob(args: {
  publishRequestId: string;
  sha: string;
  jobName: string;
  baseDetail: ReturnType<typeof parseReviewDetail>;
}): Promise<void> {
  try {
    const outcome = await waitForApplyJob(args.jobName);
    if (outcome === 'succeeded') {
      // The apply Job succeeded — but the preview's PUBLIC host DNS record is
      // created lazily and can lag the deploy by up to ~a minute before it
      // resolves publicly. Marking the preview "live" the instant the Job
      // finishes races that propagation, so the mod clicks through and hits
      // ERR_NAME_NOT_RESOLVED. Gate "live" on a real reachability probe: stay on
      // "deploying…" until the host actually answers, so the link is never dead.
      const host = args.baseDetail.host;
      const reachable = host ? await waitForReviewHostReachable(host) : true;
      if (reachable) {
        await markReviewPreviewState(args.publishRequestId, 'preview-live', args.baseDetail, {
          requireActivePreview: true,
        });
      } else {
        // Deploy is healthy but its host never became publicly reachable within
        // the budget (DNS propagation stall, or a genuinely-broken route). Do
        // NOT mark it live — that's the whole point. Free the replay-dedup slot
        // (mirror the failed branch below) so a same-sha rebuild isn't
        // suppressed within the TTL window.
        await clearReviewApplyMark(args.publishRequestId, args.sha);
        await markReviewPreviewState(
          args.publishRequestId,
          'preview-failed',
          {
            ...args.baseDetail,
            error:
              'Preview deployed but its host did not become reachable in time (DNS propagation). Rebuild to retry.',
          },
          { requireActivePreview: true }
        );
      }
    } else {
      // On a DEFINITIVE failure free the replay-dedup slot so a same-sha retry
      // isn't suppressed within the TTL window; on a 'timeout' leave it (the Job
      // may still be running — let the TTL release it rather than race a
      // re-trigger against an in-flight apply). Mirrors the production callback.
      if (outcome === 'failed') {
        await clearReviewApplyMark(args.publishRequestId, args.sha);
      }
      await markReviewPreviewState(
        args.publishRequestId,
        'preview-failed',
        {
          ...args.baseDetail,
          error: outcome === 'timeout' ? 'review deploy timed out' : 'review deploy failed',
        },
        { requireActivePreview: true }
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[review-build-callback] watch crashed for ${args.jobName}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
