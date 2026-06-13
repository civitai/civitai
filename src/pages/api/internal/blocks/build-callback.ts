import { createHmac, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { isFlipt } from '~/server/flipt/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { setCommitStatus } from '~/server/services/blocks/forgejo.service';
import { triggerApply, waitForApplyJob } from '~/server/services/blocks/apps-pipeline.service';

/**
 * POST /api/internal/blocks/build-callback
 *
 * Tekton PipelineRun finally task → civitai-web. Notified once the build
 * has either succeeded (image pushed to ghcr.io) or failed. We:
 *   1. Verify HMAC signature (BLOCK_BUILD_CALLBACK_SECRET).
 *   2. On success → create the apply Job in civitai-apps ns to roll the
 *      new image, update app_blocks.current_version_deployed_at.
 *   3. On failure → write commit status failure to Forgejo so the
 *      developer sees the result in the repo view.
 */

// HMAC verification needs the exact bytes Tekton hashed; Next's bodyParser
// re-serializes JSON before our handler sees it, which can change byte
// ordering / whitespace / numeric encoding. Read the raw stream ourselves.
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
  slug?: string;
  sha?: string;
  appBlockId?: string;
  imageRef?: string;
  status?: string; // "Succeeded" / "Failed" / "Cancelled" / ... per Tekton
};

function safeEqualHex(a: string, b: string): boolean {
  const A = Buffer.from(a, 'hex');
  const B = Buffer.from(b, 'hex');
  if (A.length === 0 || A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function verifySignature(rawBody: Buffer, header: unknown): boolean {
  const secret = env.BLOCK_BUILD_CALLBACK_SECRET;
  if (!secret) return false;
  if (typeof header !== 'string' || header.length === 0) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = header.replace(/^sha256=/, '');
  return safeEqualHex(provided, expected);
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const APB_RE = /^apb_[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The canonical immutable image the pipeline pushes for a (slug, sha):
 * `ghcr.io/civitai/app-block-<slug>:<sha>`. Bind the callback's accepted
 * imageRef to its OWN slug/sha (L-CALLBACK) — a bare `app-block-` prefix
 * check would let a signature-valid callback for slug A carry
 * `app-block-<B>:<sha>` and deploy B's image onto A's row/Deployment, and
 * would also accept a mutable `:latest` tag.
 */
export function expectedImageRef(slug: string, sha: string): string {
  return `ghcr.io/civitai/app-block-${slug}:${sha}`;
}

// Replay guard (audit LOW). The callback payload carries no timestamp/nonce, so
// a captured signature-valid request could be replayed to re-trigger the apply
// Job. Dedup the apply path on (appBlockId, sha) with an ATOMIC set-if-absent +
// TTL (not incrBy-then-expire, which could leave a permanent TTL-less key on a
// failed expire and wedge the sha forever).
//
// TTL must outlast the WHOLE first attempt, not just the apply: the mark is set
// before `triggerApply` (two k8s calls, ~60s of 30s-timeouts each) and
// `waitForApplyJob` then runs a 6m budget — worst case ~7m. We use 10m so the
// key can't expire mid-apply and let a late duplicate re-trigger (which would
// delete + restart the in-flight Job). The longer TTL does NOT suppress
// legitimate retries because every failure path frees the slot explicitly: the
// watcher clears on a DEFINITIVE apply failure, and the `triggerApply` catch
// clears on a Job-creation failure. The TTL is only the backstop for the
// can't-clear cases (apply 'timeout' where the Job may still run, or a
// watcher-crash / pod-restart). Durable cross-window replay protection still
// needs a caller-supplied signed timestamp/nonce from the Tekton finally task
// (infra follow-up).
const APPLY_DEDUP_TTL_SECONDS = 10 * 60; // > worst-case first attempt (~60s trigger + 6m apply)
function applyDedupKey(appBlockId: string, sha: string): string {
  // Reuse the block rate-limit key family (same convention as workflow-completed).
  return `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:apply:${appBlockId}:${sha}`;
}
async function markApplyTriggered(appBlockId: string, sha: string): Promise<boolean> {
  try {
    const result = await redis.set(applyDedupKey(appBlockId, sha) as never, '1', {
      NX: true,
      EX: APPLY_DEDUP_TTL_SECONDS,
    });
    // NX returns the set value when newly written, null when the key already
    // exists (replay). Test for null rather than a specific value so the
    // wrapper's return-type quirk doesn't matter.
    return result !== null;
  } catch {
    // Fail OPEN: unlike workflow-completed (which fails closed to avoid
    // double-billing), a Redis incident here must not block a real deploy.
    // The HMAC secret + imageRef↔slug/sha binding already bound the blast
    // radius, so losing replay-dedup during an outage is the lesser evil.
    return true;
  }
}
async function clearApplyMark(appBlockId: string, sha: string): Promise<void> {
  // Free the dedup slot after a definitive apply failure so a same-sha retry
  // isn't suppressed within the TTL window. Best-effort; the TTL is the backstop.
  try {
    await redis.del(applyDedupKey(appBlockId, sha) as never);
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

  // Kill switch: honour the appBlocks flag like the sibling webhooks
  // (git-push, workflow-completed). When the substrate is dark, no legitimate
  // build callback should fire — refuse so the apply/deploy chain can't run
  // independent of the flag. Server-context Flipt eval, matching the siblings.
  if (!(await isFlipt('app-blocks-enabled'))) {
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
  if (!body.slug || !SLUG_RE.test(body.slug)) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  if (!body.sha || !SHA_RE.test(body.sha)) {
    res.status(400).json({ error: 'Invalid sha' });
    return;
  }
  if (!body.appBlockId || !APB_RE.test(body.appBlockId)) {
    res.status(400).json({ error: 'Invalid appBlockId' });
    return;
  }
  // Bind the accepted imageRef to THIS callback's own slug + sha (L-CALLBACK).
  if (!body.imageRef || body.imageRef !== expectedImageRef(body.slug, body.sha)) {
    res.status(400).json({ error: 'imageRef does not match slug/sha' });
    return;
  }

  const succeeded = (body.status ?? '').toLowerCase() === 'succeeded';

  if (!succeeded) {
    await safe(setCommitStatus, {
      slug: body.slug,
      sha: body.sha,
      state: 'failure',
      context: 'civitai/build',
      description: `Build ${body.status ?? 'failed'}`,
    });
    res.status(200).json({ ok: true, applied: false, reason: 'build failed' });
    return;
  }

  // Replay guard: only run the apply path once per (appBlockId, sha) per
  // window. A replayed success callback short-circuits here before triggering
  // another apply Job or touching commit status.
  if (!(await markApplyTriggered(body.appBlockId, body.sha))) {
    res.status(200).json({ ok: true, applied: false, reason: 'duplicate callback (replay-guarded)' });
    return;
  }

  // Build succeeded — flip commit status to success on build, then start
  // the apply phase and pend commit status on deploy.
  await safe(setCommitStatus, {
    slug: body.slug,
    sha: body.sha,
    state: 'success',
    context: 'civitai/build',
    description: 'Build OK',
  });
  await safe(setCommitStatus, {
    slug: body.slug,
    sha: body.sha,
    state: 'pending',
    context: 'civitai/deploy',
    description: 'Applying to civitai-apps',
  });

  let applyJob: { name: string };
  try {
    applyJob = await triggerApply({
      slug: body.slug,
      sha: body.sha,
      appBlockId: body.appBlockId,
      imageRef: body.imageRef,
    });
  } catch (e) {
    // Job creation failed — no watcher will run to clear the dedup mark, so
    // free it here or a transient k8s hiccup would wedge same-sha retries for
    // the full TTL (symmetrical with the watcher's clear-on-failed).
    await clearApplyMark(body.appBlockId, body.sha);
    await safe(setCommitStatus, {
      slug: body.slug,
      sha: body.sha,
      state: 'failure',
      context: 'civitai/deploy',
      description: `Apply trigger failed: ${String(e).slice(0, 80)}`,
    });
    res.status(500).json({ error: 'Apply trigger failed', detail: String(e).slice(0, 240) });
    return;
  }

  // gotcha #39 fix (2026-05-30): defer the
  // `app_blocks.current_version_deployed_at` write until the apply Job
  // actually succeeds. The previous shape wrote it the moment the Job
  // was created — which meant a failed apply (smoke step / network
  // policy / image perms) left the column saying "deployed at <now>"
  // while the live Deployment was still on the previous image. Now the
  // column reflects "what's actually serving" rather than "what built."
  //
  // We respond 200 to Tekton immediately (the build callback's job was
  // to hand off to the apply chain — Tekton doesn't care about apply
  // outcome) and let the async watch update the DB row + commit status
  // in the background. Pod restart loses the watch handle, but the next
  // build for the same slug will re-create the Job which re-runs the
  // watch — the column self-heals on the next successful build.
  res.status(200).json({ ok: true, applied: true, jobName: applyJob.name });

  void watchApplyJobAndRecord({
    appBlockId: body.appBlockId,
    slug: body.slug,
    sha: body.sha,
    jobName: applyJob.name,
  });
});

/**
 * Fire-and-forget watcher: poll the apply Job until terminal, then
 * update `app_blocks.current_version_deployed_at` (on success) + flip
 * the Forgejo commit status. Errors are logged + swallowed; the user-
 * facing response has already shipped.
 */
async function watchApplyJobAndRecord(args: {
  appBlockId: string;
  slug: string;
  sha: string;
  jobName: string;
}): Promise<void> {
  try {
    const outcome = await waitForApplyJob(args.jobName);
    if (outcome === 'succeeded') {
      await dbWrite.appBlock.update({
        where: { id: args.appBlockId },
        data: { currentVersionDeployedAt: new Date() },
      });
      await safe(setCommitStatus, {
        slug: args.slug,
        sha: args.sha,
        state: 'success',
        context: 'civitai/deploy',
        description: 'Deployed to civitai-apps',
      });
    } else {
      // Failure or timeout — leave the existing currentVersionDeployedAt
      // alone (it correctly reflects the LAST successful deploy, not the
      // failed/in-flight one). On a DEFINITIVE failure, free the replay-dedup
      // slot so a same-sha retry isn't suppressed within the TTL window; on a
      // 'timeout' leave it (the Job may still be running — let the TTL release
      // it rather than race a re-trigger against an in-flight apply).
      if (outcome === 'failed') {
        await clearApplyMark(args.appBlockId, args.sha);
      }
      // Flip commit status so the dev sees red.
      await safe(setCommitStatus, {
        slug: args.slug,
        sha: args.sha,
        state: 'failure',
        context: 'civitai/deploy',
        description: outcome === 'timeout' ? 'Deploy timed out' : 'Deploy failed',
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[build-callback] apply Job ${args.jobName} ended ${outcome}; current_version_deployed_at not updated`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[build-callback] watchApplyJob crashed for ${args.jobName}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// Wrap a side-effect with a try/catch that logs but doesn't bubble.
async function safe<T extends (...args: any[]) => Promise<any>>(fn: T, ...args: Parameters<T>) {
  try {
    await fn(...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[build-callback] side-effect failed:', String(e).slice(0, 240));
  }
}
