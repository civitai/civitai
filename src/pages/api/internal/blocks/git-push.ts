import { createHmac, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { isAppBlocksPipelineEnabled } from '~/server/services/app-blocks-flag';
import {
  BlockManifestValidator,
  type AppContext,
} from '~/server/services/block-manifest-validator.service';
import { FORGEJO_ORG, getRawFile, setCommitStatus } from '~/server/services/blocks/forgejo.service';
import { stampCanonicalIframeSrc } from '~/server/services/blocks/manifest-normalize';
import { recordPendingFromPush } from '~/server/services/blocks/publish-request.service';

/**
 * POST /api/internal/blocks/git-push
 *
 * Forgejo push-event webhook for `civitai-apps/*`. Verifies the HMAC
 * signature (FORGEJO_WEBHOOK_SECRET), pulls the block.manifest.json out
 * of the just-pushed commit, and validates it against the canonical schema.
 *
 * NO TRUST ON PUSH (v1 mod-review gate): a signature-valid push does NOT
 * by itself approve or deploy anything. The build + deploy is triggered by
 * `approveRequest` (the moderator path) when a mod approves a publish
 * request; that approve stamps the approved sha onto
 * `app_blocks.current_version_sha` BEFORE its commit fires this webhook, so:
 *   - sha === app_blocks.current_version_sha → the moderator-approved,
 *     in-flight deploy → no-op here (approveRequest already triggered it).
 *   - any other sha → an UNREVIEWED direct push to civitai-apps/<slug> →
 *     recorded as a `pending` publish request and left for moderator review.
 *     It never auto-approves and never deploys.
 *
 * Forgejo write access is a different trust domain than civitai moderation,
 * so this gate is what stops anyone with repo write from shipping arbitrary
 * iframe code to a live, mod-page-embedded block.
 *
 * Manifest validation failures surface as commit-status `failure` on
 * Forgejo so the developer sees the error in the repo view, no email
 * trip-wire needed.
 *
 * Idempotency: re-deliveries of the same (slug, sha) are safe — the
 * approved-deploy case is a stable no-op, and the pending-review case
 * refreshes the existing (slug, sha) pending row rather than stacking.
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

export function verifyForgejoSignature(rawBody: Buffer, signatureHeader: unknown): boolean {
  // F6 — dual-secret HMAC rotation window. Accept a signature that matches
  // EITHER the current secret OR an optional FORGEJO_WEBHOOK_SECRET_NEXT. To
  // rotate with zero downtime: set _NEXT to the new secret, flip the Forgejo
  // signer to the new secret, then move the new value into FORGEJO_WEBHOOK_SECRET
  // and clear _NEXT. When _NEXT is unset this is byte-identical to the prior
  // single-secret behaviour (fail-closed: no secret configured → false).
  //
  // This is the civitai-web leg of the three-secret zero-downtime rotation; the
  // app-blocks-trigger receiver already dual-accepts APPS_TEKTON_TRIGGER_SECRET
  // + _NEXT on the talos side (see HMAC-SECRET-ROTATION.md). Mirrors the
  // BLOCK_TOKEN_PUBLIC_KEY_NEXT precedent in block-token.service.ts.
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
  // Forgejo sends the header bare (no `sha256=` prefix); be tolerant either way.
  const provided = signatureHeader.replace(/^sha256=/, '');

  // Filter empty/undefined BEFORE createHmac so we never compute an empty-key
  // HMAC (which would be a usable, attacker-known key). No secret set at all →
  // reject (fail-closed).
  const secrets = [env.FORGEJO_WEBHOOK_SECRET, env.FORGEJO_WEBHOOK_SECRET_NEXT].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  if (secrets.length === 0) return false;

  // Compute every candidate comparison (no boolean short-circuit) so timing
  // doesn't leak which secret — current vs NEXT — was the matching one.
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (safeEqualHex(provided, expected)) matched = true;
  }
  return matched;
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
export function parseExpectedRepo(fullName: unknown, expectedOrg: string): { slug: string } | null {
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

  // Kill switch — block all platform mutations when the pipeline is off.
  // Decision 1: gated on the dedicated global `app-blocks-pipeline-enabled` flag
  // (NOT the mod-segmented user flag) so the publish pipeline can run.
  const enabled = await isAppBlocksPipelineEnabled();
  if (!enabled) {
    res.status(503).json({ error: 'Apps are not enabled' });
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
      currentVersionSha: true,
      app: { select: { id: true, allowedScopes: true, allowedOrigins: true } },
    },
  });
  if (!appBlock) {
    res.status(404).json({ error: 'app_blocks row not found — re-run submitApp' });
    return;
  }

  // SECURITY (no trust-on-push): `approveRequest` is the ONLY path that may
  // ship new iframe code to a live block. When a moderator approves a publish
  // request it commits the reviewed bundle to civitai-apps/<slug>, stamps the
  // resulting sha onto app_blocks.current_version_sha, AND triggers the Tekton
  // build itself. The push it makes lands here too — but it is already the
  // approved, in-flight deploy, so this webhook treats `sha ===
  // appBlock.currentVersionSha` as a no-op (the build is already running).
  //
  // ANY OTHER push to civitai-apps/<slug>:main is, by construction, NOT
  // moderator-approved (Forgejo write access is a different trust domain than
  // civitai moderation). Such a push must NEVER auto-approve and NEVER deploy:
  // we record it as a `pending` publish request — the same review artifact a
  // submitVersion produces — and stop. A moderator then approves the new sha
  // through the existing approveRequest → build → deploy path. This is the v1
  // mod-review gate the original handler comment promised ("v0 auto-approves on
  // valid push; v1 gates this behind a queue").
  if (sha === appBlock.currentVersionSha) {
    res.status(200).json({ ok: true, slug, sha, deploy: 'already-approved' });
    return;
  }
  // Race backstop: approveRequest stamps current_version_sha and finalises the
  // publish request (status='approved', forgejoCommitSha=sha) right after its
  // commit — but its commit fires THIS webhook, so the webhook can in principle
  // arrive in the narrow window before those writes land. An `approved` publish
  // request for (slug, sha) is the same durable proof of moderator approval, so
  // treat it as the in-flight approved deploy too (no-op). A direct attacker
  // push has neither marker.
  const approvedForThisSha = await dbRead.appBlockPublishRequest.findFirst({
    where: { slug, status: 'approved', forgejoCommitSha: sha },
    select: { id: true },
  });
  if (approvedForThisSha) {
    res.status(200).json({ ok: true, slug, sha, deploy: 'already-approved' });
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

  // iframe.src is platform-owned (see manifest-normalize.ts). Stamp the
  // canonical per-app subdomain root onto the parsed manifest BEFORE validation
  // + the exact-match check below, so an unreviewed direct push that omitted
  // iframe.src (or carried a stale host) is normalized rather than rejected. The
  // approve flow already commits a canonical manifest, so this is also belt-and-
  // suspenders for that path. `slug` (the repo name) is the source of truth.
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    stampCanonicalIframeSrc(manifest as Record<string, unknown>, slug, env.APPS_DOMAIN);
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

  // Require canonical iframe.src host — must match <slug>.<APPS_DOMAIN>/. Now
  // belt-and-suspenders: the stamp above already forces iframe.src to exactly
  // this value for any object manifest, so this branch only fires if that
  // stamping is ever removed/changed — keep it as a defense-in-depth guard.
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
      details: `manifest.iframe.src="${
        parsedManifest.iframe?.src ?? ''
      }" but expected "${expectedSrc}"`,
    });
    res.status(400).json({ error: 'iframe.src mismatch' });
    return;
  }

  // We only reach here for a push whose sha is NOT the moderator-approved,
  // in-flight deploy (that case returned above). By construction this is an
  // UNREVIEWED push straight to civitai-apps/<slug>:main. Do NOT touch
  // app_blocks.status and do NOT trigger a build/deploy. Instead record (or
  // refresh) a `pending` publish request for this sha so a moderator can
  // review it via the existing /apps/review → approveRequest path, which is
  // the only thing that may ship it to the live block.
  //
  // The manifest validated above is the source of truth for slug / version.
  const reviewVersion = (parsedManifest as { version?: string }).version ?? sha.slice(0, 7);
  try {
    await recordPendingFromPush({
      slug,
      sha,
      appBlockId: appBlock.id,
      manifest: manifest as object,
      version: reviewVersion,
    });
  } catch (e) {
    notifyModsOfWebhookFailure({
      slug,
      sha,
      stage: 'record-pending-review',
      details: `could not record pending review request: ${String(e).slice(0, 200)}`,
    });
    res
      .status(500)
      .json({ error: 'Could not record pending review request', detail: String(e).slice(0, 240) });
    return;
  }

  // Surface the gate in Forgejo's commit view so a developer who pushed
  // directly sees WHY nothing deployed.
  await setCommitStatusSafe({
    slug,
    sha,
    state: 'pending',
    context: 'civitai/review',
    description: 'Awaiting moderator review — not deployed',
  });

  // Ping mods that an unreviewed push is waiting in the queue.
  notifyModsOfWebhookFailure({
    slug,
    sha,
    stage: 'unreviewed-push',
    details:
      'Direct push to the canonical build repo recorded as a PENDING review request. ' +
      'It will NOT build or deploy until a moderator approves it via /apps/review.',
  });

  res.status(202).json({ ok: true, slug, sha, status: 'pending-review', deployed: false });
});

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
        title: `🚨 Apps build-chain rejected: ${opts.slug}`,
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
        footer: { text: 'Apps git-push webhook' },
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
