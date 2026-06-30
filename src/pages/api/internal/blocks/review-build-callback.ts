import { createHmac, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { isAppBlocksPipelineEnabled } from '~/server/services/app-blocks-flag';
import { triggerApplyReview, waitForApplyJob } from '~/server/services/blocks/apps-pipeline.service';
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
    res.status(503).json({ error: 'App Blocks not enabled' });
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
  try {
    const { dbRead } = await import('~/server/db/client');
    const row = await dbRead.appBlockPublishRequest.findUnique({
      where: { id: body.publishRequestId },
      select: { deployDetail: true },
    });
    baseDetail = { ...parseReviewDetail(row?.deployDetail), sha: body.sha };
  } catch {
    /* fall back to the minimal detail */
  }

  const succeeded = (body.status ?? '').toLowerCase() === 'succeeded';
  if (!succeeded) {
    await markReviewPreviewState(body.publishRequestId, 'preview-failed', {
      ...baseDetail,
      error: `review build ${String(body.status ?? 'failed').slice(0, 60)}`,
    });
    res.status(200).json({ ok: true, applied: false, reason: 'review build failed' });
    return;
  }

  await markReviewPreviewState(body.publishRequestId, 'preview-deploying', baseDetail);

  let applyJob: { name: string };
  try {
    applyJob = await triggerApplyReview({
      slug: body.slug,
      sha: body.sha,
      publishRequestId: body.publishRequestId,
      imageRef: body.imageRef,
    });
  } catch (e) {
    await markReviewPreviewState(body.publishRequestId, 'preview-failed', {
      ...baseDetail,
      error: `review apply trigger failed: ${String(e).slice(0, 80)}`,
    });
    res.status(500).json({ error: 'Review apply trigger failed', detail: String(e).slice(0, 240) });
    return;
  }

  // Respond 200 to Tekton immediately; watch the apply Job async + flip the
  // preview state to live/failed in the background (same shape as the production
  // build-callback's fire-and-forget watcher).
  res.status(200).json({ ok: true, applied: true, jobName: applyJob.name });

  void watchReviewApplyJob({
    publishRequestId: body.publishRequestId,
    jobName: applyJob.name,
    baseDetail,
  });
});

async function watchReviewApplyJob(args: {
  publishRequestId: string;
  jobName: string;
  baseDetail: ReturnType<typeof parseReviewDetail>;
}): Promise<void> {
  try {
    const outcome = await waitForApplyJob(args.jobName);
    if (outcome === 'succeeded') {
      await markReviewPreviewState(args.publishRequestId, 'preview-live', args.baseDetail);
    } else {
      await markReviewPreviewState(args.publishRequestId, 'preview-failed', {
        ...args.baseDetail,
        error: outcome === 'timeout' ? 'review deploy timed out' : 'review deploy failed',
      });
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
