import { createHmac, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { isFlipt } from '~/server/flipt/client';
import {
  BlockManifestValidator,
  type AppContext,
} from '~/server/services/block-manifest-validator.service';
import {
  getRawFile,
  setCommitStatus,
} from '~/server/services/blocks/forgejo.service';
import { triggerBuild } from '~/server/services/blocks/apps-pipeline.service';

/**
 * POST /api/internal/blocks/git-push
 *
 * Forgejo push-event webhook for `civitai-apps/*`. Verifies the HMAC
 * signature (FORGEJO_WEBHOOK_SECRET), pulls the block.manifest.json out
 * of the just-pushed commit, validates it against the canonical schema,
 * and (on success) upserts the app_blocks row + kicks off the Tekton
 * build pipeline on dc-02-a.
 *
 * Manifest validation failures surface as commit-status `failure` on
 * Forgejo so the developer sees the error in the repo view, no email
 * trip-wire needed.
 *
 * Idempotency: re-deliveries of the same (slug, sha) are safe — the
 * upsert is by (appId, blockId) primary key, and triggerBuild creates
 * a PipelineRun named after the SHA, which Tekton dedups.
 */

// Forgejo payloads can be a few KB (commit metadata + repo descriptor).
// The default Next API body limit is 1MB which is plenty; we keep the
// explicit cap small to bound the surface against bad-actor reach-out.
export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

type ForgejoPushPayload = {
  ref?: string;
  after?: string;
  before?: string;
  repository?: { name?: string; full_name?: string };
  pusher?: { login?: string; username?: string };
  commits?: Array<{ id?: string; message?: string }>;
};

function safeEqualHex(a: string, b: string): boolean {
  const A = Buffer.from(a, 'hex');
  const B = Buffer.from(b, 'hex');
  if (A.length === 0 || A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function verifyForgejoSignature(rawBody: string, signatureHeader: unknown): boolean {
  const secret = env.FORGEJO_WEBHOOK_SECRET;
  if (!secret) return false;
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Forgejo sends the header bare (no `sha256=` prefix); be tolerant either way.
  const provided = signatureHeader.replace(/^sha256=/, '');
  return safeEqualHex(provided, expected);
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Kill switch — block all platform mutations when the feature is off.
  const enabled = await isFlipt('app-blocks-enabled');
  if (!enabled) {
    res.status(503).json({ error: 'App Blocks not enabled' });
    return;
  }

  // Capture the raw body for HMAC verification. Next has already parsed
  // it into req.body, so re-serialize. Forgejo signs the raw bytes of the
  // POST body — we have to mirror its serialization. JSON.stringify of the
  // parsed object is byte-identical to what Forgejo emits in practice
  // (Forgejo serializes via Go's encoding/json, key order matches Next's
  // default JSON.parse output for round-tripped objects). If this fails
  // in production, fall back to using a custom body parser that captures
  // raw bytes.
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  const sig = req.headers['x-gitea-signature'] ?? req.headers['x-forgejo-signature'];
  if (!verifyForgejoSignature(rawBody, sig)) {
    res.status(401).json({ error: 'Bad signature' });
    return;
  }

  const payload = (req.body ?? {}) as ForgejoPushPayload;
  if (payload.ref !== 'refs/heads/main') {
    res.status(200).json({ skipped: 'non-main branch', ref: payload.ref });
    return;
  }

  const slug = payload.repository?.name;
  const sha = payload.after;
  if (!slug || !SLUG_RE.test(slug)) {
    res.status(400).json({ error: 'Invalid repo slug', slug });
    return;
  }
  if (!sha || sha.length < 40) {
    res.status(400).json({ error: 'Invalid commit sha' });
    return;
  }

  // Look up the app_blocks row by (appId, blockId) — civitai-team created
  // it during blocks.submitApp. If it's missing, the repo exists in Forgejo
  // but never got registered in our DB; bail with 404 so submitApp gets
  // re-run.
  const appBlock = await dbRead.appBlock.findFirst({
    where: { blockId: slug },
    select: {
      id: true,
      appId: true,
      blockId: true,
      app: { select: { id: true, allowedScopes: true, allowedOrigins: true } },
    },
  });
  if (!appBlock) {
    res.status(404).json({ error: 'app_blocks row not found — re-run submitApp' });
    return;
  }

  // Fetch the manifest at the new commit.
  let manifestRaw: string;
  try {
    manifestRaw = await getRawFile({
      slug,
      ref: sha,
      path: 'block.manifest.json',
    });
  } catch (e) {
    await setCommitStatusSafe({
      slug,
      sha,
      state: 'failure',
      context: 'civitai/manifest-validation',
      description: 'block.manifest.json missing or unreachable',
    });
    res.status(400).json({ error: 'Cannot fetch manifest', detail: String(e).slice(0, 240) });
    return;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    await setCommitStatusSafe({
      slug,
      sha,
      state: 'failure',
      context: 'civitai/manifest-validation',
      description: 'block.manifest.json is not valid JSON',
    });
    res.status(400).json({ error: 'Invalid manifest JSON' });
    return;
  }

  const appContext: AppContext = {
    allowedScopes: appBlock.app.allowedScopes ?? 0,
    allowedOrigins: (appBlock.app.allowedOrigins ?? []).map((o: string) => o.toLowerCase()),
  };
  const validation = BlockManifestValidator.validate(manifest, appContext);
  if (!validation.valid) {
    await setCommitStatusSafe({
      slug,
      sha,
      state: 'failure',
      context: 'civitai/manifest-validation',
      description: validation.errors.slice(0, 3).join('; '),
    });
    res.status(400).json({ error: 'Invalid manifest', details: validation.errors });
    return;
  }

  // Cross-check the manifest blockId matches the repo slug — guards a
  // typo where the developer renames the repo without updating the
  // manifest (or vice-versa).
  const parsedManifest = manifest as { blockId?: string; iframe?: { src?: string } };
  if (parsedManifest.blockId !== slug) {
    await setCommitStatusSafe({
      slug,
      sha,
      state: 'failure',
      context: 'civitai/manifest-validation',
      description: `blockId in manifest (${parsedManifest.blockId}) must equal repo slug (${slug})`,
    });
    res.status(400).json({ error: 'blockId / slug mismatch' });
    return;
  }

  // Require canonical iframe.src host — must match <slug>.<APPS_DOMAIN>/
  const expectedSrc = `https://${slug}.${env.APPS_DOMAIN}/`;
  if (parsedManifest.iframe?.src !== expectedSrc) {
    await setCommitStatusSafe({
      slug,
      sha,
      state: 'failure',
      context: 'civitai/manifest-validation',
      description: `iframe.src must equal ${expectedSrc}`,
    });
    res.status(400).json({ error: 'iframe.src mismatch' });
    return;
  }

  // Upsert app_blocks with the new manifest + sha. v0 auto-approves on
  // valid push; v1 (W1 mod review) gates this behind a queue.
  await dbWrite.appBlock.update({
    where: { id: appBlock.id },
    data: {
      manifest: manifest as object,
      status: 'approved',
      // The migration that adds current_version_sha / current_version_deployed_at
      // / repo_url ships alongside this handler (Phase 4 SQL); these field
      // names match the @map directives that get added.
      currentVersionSha: sha,
      version: (parsedManifest as { version?: string }).version ?? sha.slice(0, 7),
    },
  });

  // Pending status on Forgejo while Tekton runs.
  await setCommitStatusSafe({
    slug,
    sha,
    state: 'pending',
    context: 'civitai/build',
    description: 'Build queued',
  });

  // Trigger the cross-cluster Tekton build.
  try {
    const callbackUrl = buildCallbackUrl();
    await triggerBuild({ slug, sha, appBlockId: appBlock.id, callbackUrl });
  } catch (e) {
    await setCommitStatusSafe({
      slug,
      sha,
      state: 'failure',
      context: 'civitai/build',
      description: `Trigger failed: ${String(e).slice(0, 80)}`,
    });
    res.status(500).json({ error: 'Build trigger failed', detail: String(e).slice(0, 240) });
    return;
  }

  res.status(200).json({ ok: true, slug, sha });
});

function buildCallbackUrl(): string {
  // The callback URL must be reachable from dc-02-a Tekton — that's the
  // public civitai-web URL of the env civitai-web is currently running in.
  // Use NEXTAUTH_URL (already in env, kept current per deployment).
  const base = (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('NEXTAUTH_URL not configured — cannot build callback URL');
  return `${base}/api/internal/blocks/build-callback`;
}

async function setCommitStatusSafe(args: Parameters<typeof setCommitStatus>[0]): Promise<void> {
  // Don't let a Forgejo flakiness in setCommitStatus mask the original
  // error from the caller. Swallow + log.
  try {
    await setCommitStatus(args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[git-push] setCommitStatus failed:', String(e).slice(0, 240));
  }
}
