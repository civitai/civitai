import { createHmac, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { isFlipt } from '~/server/flipt/client';
import {
  BlockManifestValidator,
  type AppContext,
} from '~/server/services/block-manifest-validator.service';
import {
  FORGEJO_ORG,
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

// HMAC verification requires raw request bytes — Forgejo signs the exact
// pretty-printed JSON it emits (Go's encoding/json with indent), which is
// NOT byte-identical to Next's JSON.stringify of the parsed object. Turn
// off Next's body parser and read the stream ourselves so the bytes we
// hash match the bytes Forgejo hashed.
export const config = {
  api: { bodyParser: false },
};

const MAX_BODY_BYTES = 64 * 1024;

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

function verifyForgejoSignature(rawBody: Buffer, signatureHeader: unknown): boolean {
  const secret = env.FORGEJO_WEBHOOK_SECRET;
  if (!secret) return false;
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Forgejo sends the header bare (no `sha256=` prefix); be tolerant either way.
  const provided = signatureHeader.replace(/^sha256=/, '');
  return safeEqualHex(provided, expected);
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * Parse a Forgejo `repository.full_name` (`<org>/<slug>`) and assert the
 * org is the canonical build-trigger org. Returns the slug only when the
 * org matches; otherwise null. Pulled out as a pure function for unit
 * testing the M-WEBHOOK org gate without driving the full webhook handler.
 *
 * The shared FORGEJO_WEBHOOK_SECRET authenticates the Forgejo *instance*,
 * not a single repo/org — the same instance also serves the
 * `civitai-apps-review` org (anonymous in-review browsing) and could serve
 * others. Without this gate a signature-valid push to a same-slug repo in a
 * different org would drive a build + auto-approve of the canonical row.
 */
export function parseExpectedRepo(
  fullName: unknown,
  expectedOrg: string
): { slug: string } | null {
  if (typeof fullName !== 'string' || !fullName.includes('/')) return null;
  const [org, ...slugParts] = fullName.split('/');
  if (org !== expectedOrg) return null;
  const slug = slugParts.join('/');
  if (!slug) return null;
  return { slug };
}

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

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }

  const sig = req.headers['x-gitea-signature'] ?? req.headers['x-forgejo-signature'];
  if (!verifyForgejoSignature(rawBody, sig)) {
    res.status(401).json({ error: 'Bad signature' });
    return;
  }

  let payload: ForgejoPushPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as ForgejoPushPayload;
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  if (payload.ref !== 'refs/heads/main') {
    res.status(200).json({ skipped: 'non-main branch', ref: payload.ref });
    return;
  }

  // Verify the push came from the canonical build-trigger org and derive the
  // slug from `repository.full_name` (`<org>/<slug>`) so org + slug are
  // validated together — don't trust `repository.name` alone (M-WEBHOOK).
  const expectedRepo = parseExpectedRepo(payload.repository?.full_name, FORGEJO_ORG);
  if (!expectedRepo) {
    res.status(403).json({
      error: 'Unexpected or missing repository org',
      fullName: payload.repository?.full_name ?? null,
    });
    return;
  }
  const slug = expectedRepo.slug;
  const sha = payload.after;
  if (!slug || !SLUG_RE.test(slug)) {
    res.status(400).json({ error: 'Invalid repo slug', slug });
    return;
  }
  if (!sha || sha.length < 40) {
    res.status(400).json({ error: 'Invalid commit sha' });
    return;
  }

  // Look up the app_blocks row by (appId, blockId). Under W1 the row is
  // pre-created in `approveRequest` before this webhook fires; if it's
  // missing the Forgejo commit raced ahead of the approve flow's DB
  // insert, so bail with 404 and the mod can re-approve.
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
    notifyModsOfWebhookFailure({
      slug,
      sha,
      stage: 'fetch-manifest',
      details: `block.manifest.json missing or unreachable: ${String(e).slice(0, 200)}`,
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
    notifyModsOfWebhookFailure({
      slug,
      sha,
      stage: 'parse-manifest',
      details: 'block.manifest.json is not valid JSON',
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
    notifyModsOfWebhookFailure({
      slug,
      sha,
      stage: 'manifest-validation',
      details: validation.errors.slice(0, 5).join('; '),
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
    notifyModsOfWebhookFailure({
      slug,
      sha,
      stage: 'blockId-slug-mismatch',
      details: `manifest.blockId="${parsedManifest.blockId}" but repo slug="${slug}"`,
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
    notifyModsOfWebhookFailure({
      slug,
      sha,
      stage: 'iframe-src-mismatch',
      details: `manifest.iframe.src="${parsedManifest.iframe?.src ?? ''}" but expected "${expectedSrc}"`,
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
    notifyModsOfWebhookFailure({
      slug,
      sha,
      stage: 'trigger-build',
      details: `triggerBuild() failed: ${String(e).slice(0, 200)}`,
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

/**
 * Fire-and-forget Discord ping when the build chain fails at this
 * webhook (validator reject, slug/iframe mismatch, trigger failure).
 *
 * After the H-4 fix in publish-request.service.ts.approveRequest runs
 * the same validator BEFORE writing app_blocks, this should never fire
 * on the canonical /apps/submit → /apps/review flow — the approve call
 * itself surfaces validation errors inline to the mod. This ping is the
 * defense-in-depth signal that catches:
 *   - direct pushes to civitai-apps/<slug> on Forgejo bypassing the
 *     mod review UI
 *   - drift between the approve-side and webhook-side validator (e.g.
 *     a new check added to one and not the other)
 *   - triggerBuild failures (Tekton receiver down, HMAC drift, network)
 *
 * No-op if DISCORD_WEBHOOK_MOD_ALERTS is unset. Never throws.
 */
function notifyModsOfWebhookFailure(opts: {
  slug: string;
  sha: string;
  stage: string;
  details: string;
}): void {
  if (!env.DISCORD_WEBHOOK_MOD_ALERTS) return;
  const baseUrl = (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '');
  const reviewUrl = baseUrl ? `${baseUrl}/apps/review` : '/apps/review';
  const payload = {
    embeds: [
      {
        title: `🚨 App Blocks build-chain rejected: ${opts.slug}`,
        description:
          'The git-push webhook refused the commit — the live pod is unchanged. ' +
          'After the H-4 fix this should not fire from the normal /apps/review approve ' +
          'flow; investigate direct pushes or validator drift.',
        url: reviewUrl,
        color: 0xc92a2a,
        fields: [
          { name: 'Slug', value: opts.slug, inline: true },
          { name: 'Stage', value: opts.stage, inline: true },
          { name: 'Commit', value: `\`${opts.sha.slice(0, 12)}\``, inline: true },
          { name: 'Details', value: opts.details.slice(0, 900) || '(none)' },
        ],
        footer: { text: 'App Blocks git-push webhook' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  // Cast as ResponseInit is fine here — global.fetch is webapi compatible
  // in Next's Node runtime. AbortSignal.timeout caps the call so a Discord
  // outage can't slow the 4xx response we're about to send to Forgejo.
  fetch(env.DISCORD_WEBHOOK_MOD_ALERTS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    /* fire and forget */
  });
}
