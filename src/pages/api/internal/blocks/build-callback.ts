import { createHmac, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { sysRedis } from '~/server/redis/client';
import { setCommitStatus } from '~/server/services/blocks/forgejo.service';
import {
  callbackPendingRedisKey,
  triggerApply,
  waitForApplyJob,
} from '~/server/services/blocks/apps-pipeline.service';

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
  // F5 — integer unix-second timestamp the SIGNER (datapacket-talos callback
  // task) stamps into the body before HMAC. Validated for skew here. ABSENT is
  // allowed (rollout tolerance — the signer adds it in its own PR).
  ts?: unknown;
};

// F5 — allowed clock skew between the callback signer and this receiver, in
// seconds. A replayed callback carries its original (now-stale) `ts` inside the
// signed body, so it fails this window. 5 minutes mirrors the trigger leg.
const TS_TOLERANCE_SECONDS = 300;

/**
 * Replay-tolerance decision for the (verified) callback `ts` (F5).
 *   - absent → allow (rollout tolerance: the datapacket-talos callback-task
 *     signer adds `ts` in its own PR; enforce-if-present avoids a
 *     deploy-ordering outage).
 *   - present + within ±TS_TOLERANCE_SECONDS of now → allow.
 *   - present + a non-finite / out-of-tolerance value → reject.
 * Pure + exported so the skew window is unit-tested without driving the handler.
 */
export function checkCallbackTimestamp(
  ts: unknown,
  nowSec: number = Math.floor(Date.now() / 1000)
): { ok: true } | { ok: false; reason: string } {
  if (ts === undefined || ts === null) return { ok: true }; // enforce-if-present
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return { ok: false, reason: 'ts present but not a finite number' };
  }
  if (Math.abs(nowSec - ts) > TS_TOLERANCE_SECONDS) {
    return { ok: false, reason: `ts skew ${Math.abs(nowSec - ts)}s exceeds ${TS_TOLERANCE_SECONDS}s` };
  }
  return { ok: true };
}

/**
 * Consume the build-callback pending-run marker (F5 cross-check). GETDELs the
 * `system:blocks:callback:pending:<slug>:<sha>:<appBlockId>` key written by
 * triggerBuild — consume-once, so a replayed callback finds it already gone.
 *
 * Returns:
 *   - 'consumed' — the marker existed and was deleted (genuine outstanding run).
 *   - 'missing'  — no marker (replay, out-of-band callback, or a Redis blip on
 *     the trigger side that never wrote it).
 *   - 'unavailable' — Redis itself errored; the caller must NOT fail a legit
 *     deploy on a Redis blip, so this is treated as "not enforced".
 */
export async function consumePendingRun(
  slug: string,
  sha: string,
  appBlockId: string
): Promise<'consumed' | 'missing' | 'unavailable'> {
  const key = callbackPendingRedisKey(slug, sha, appBlockId);
  try {
    // GETDEL is atomic consume-once. The typed client wrapper doesn't expose
    // getDel; call the underlying node-redis command (key shape is validated by
    // callbackPendingRedisKey above).
    const prior = await (sysRedis as unknown as {
      getDel: (k: string) => Promise<string | null>;
    }).getDel(key);
    return prior == null ? 'missing' : 'consumed';
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[build-callback] pending-run GETDEL failed for ${slug}@${sha.slice(0, 8)} — treating as not-enforced: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return 'unavailable';
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const A = Buffer.from(a, 'hex');
  const B = Buffer.from(b, 'hex');
  if (A.length === 0 || A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

export function verifySignature(rawBody: Buffer, header: unknown): boolean {
  // Dual-acceptance rotation window (audit F6): accept a signature that matches
  // EITHER the current secret OR an optional BLOCK_BUILD_CALLBACK_SECRET_NEXT.
  // To rotate with zero downtime: set _NEXT to the new secret, flip the Tekton
  // callback signer to the new secret, then move the new value into
  // BLOCK_BUILD_CALLBACK_SECRET and clear _NEXT. When _NEXT is unset this is
  // identical to single-secret behavior (fail-closed: no secret → false).
  if (typeof header !== 'string' || header.length === 0) return false;
  const provided = header.replace(/^sha256=/, '');

  const secrets = [
    env.BLOCK_BUILD_CALLBACK_SECRET,
    env.BLOCK_BUILD_CALLBACK_SECRET_NEXT,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) return false;

  // Compute every candidate comparison (no boolean short-circuit) so we don't
  // leak via timing which secret — current vs NEXT — was the matching one.
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (safeEqualHex(provided, expected)) matched = true;
  }
  return matched;
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

  // F5 — replay tolerance on the (now HMAC-verified) `ts`. The signer stamps
  // `ts` inside the signed body, so a replay carries its original stale value
  // and is rejected here; an absent `ts` is allowed for rollout (the
  // datapacket-talos callback-task signer adds it in its own PR).
  const tsCheck = checkCallbackTimestamp(body.ts);
  if (!tsCheck.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[build-callback] rejecting replayed/stale callback for ${body.slug}@${body.sha.slice(
        0,
        8
      )}: ${tsCheck.reason}`
    );
    res.status(401).json({ error: 'Stale or invalid timestamp' });
    return;
  }

  // F5 — consume-once pending-run cross-check. triggerBuild records an
  // outstanding (slug, sha, appBlockId) marker; GETDEL it here. This is the
  // real replay teeth for the public-edge callback leg (a replay finds the
  // marker already consumed/expired). Behavior on MISSING is gated:
  //   - BLOCK_CALLBACK_REQUIRE_PENDING_RUN === 'true' → reject (409).
  //   - default → log + CONTINUE (report-only first deploy).
  // A Redis error ('unavailable') is never allowed to break a legit deploy.
  const pending = await consumePendingRun(body.slug, body.sha, body.appBlockId);
  if (pending === 'missing') {
    const enforce = env.BLOCK_CALLBACK_REQUIRE_PENDING_RUN === 'true';
    // eslint-disable-next-line no-console
    console.warn(
      `[build-callback] no pending-run marker for ${body.slug}@${body.sha.slice(0, 8)} (${
        body.appBlockId
      }) — ${enforce ? 'REJECTING (enforce on)' : 'continuing (report-only)'}`
    );
    if (enforce) {
      res.status(409).json({ error: 'No outstanding build run for this callback' });
      return;
    }
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
      // failed/in-flight one). Flip commit status so the dev sees red.
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
