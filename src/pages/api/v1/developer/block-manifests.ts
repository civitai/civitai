import { timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { newAppBlockId } from '~/server/utils/app-block-ids';
import { BlockManifestValidator } from '~/server/services/block-manifest-validator.service';

// B5: cap the body parser BEFORE the JSON.stringify size check. Next's
// default is 1MB; we want to reject oversize uploads before they hit
// the JSON parser, not after. Especially critical once v2 drops the
// JOB_TOKEN gate and this becomes externally reachable.
export const config = {
  api: {
    bodyParser: { sizeLimit: '64kb' },
  },
};

/**
 * POST /api/v1/developer/block-manifests
 *
 * v1: internal-only. Guarded by the JOB_TOKEN shared secret (the same one
 *      Anthropic-internal cronjobs use). External developers are blocked
 *      until v2 when the per-app key issuance flow lands.
 * v2:  remove the JOB_TOKEN guard and authenticate via the app's OAuth client.
 *
 * Moderation contract (audit H-1):
 *  - New blocks: created with `status='pending'`. They do NOT render until
 *    a moderator approves them. This was already the case.
 *  - Existing blocks: ANY manifest update via this endpoint resets the row
 *    to `status='pending'`. This means a publisher cannot silently swap
 *    iframe.src or sandbox tokens post-approval — every change re-enters
 *    moderation. The previous implementation preserved the prior status,
 *    which was a privilege-escalation path (the JOB_TOKEN gate is the only
 *    guard and audit logging lands in Phase 3).
 *  - trustTier and renderMode are NEVER accepted from the payload on
 *    update. Promoting an unverified block to internal would lift the
 *    sandbox allowlist gate and effectively bypass iframe isolation. Tier
 *    changes must come from an explicit admin action (separate PR).
 */

function safeEqualHeader(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // M-6: constant-time compare. The secret is high-entropy so a timing
  // oracle is mostly theoretical, but the standard fix is cheap.
  if (!env.JOB_TOKEN || !safeEqualHeader(req.headers['x-civitai-internal-token'], env.JOB_TOKEN)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  // H-2: gate manifest registration on the feature flag. Even with
  // JOB_TOKEN, we don't want manifests landing while the substrate is dark.
  if (!(await isAppBlocksEnabled())) {
    res.status(503).json({ error: 'Apps are not enabled' });
    return;
  }

  const body = (req.body ?? {}) as {
    appId?: unknown;
    manifest?: Record<string, unknown>;
  };
  if (typeof body.appId !== 'string' || !body.manifest || typeof body.manifest !== 'object') {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  // L5 / H5: bound the raw manifest size in BYTES before validation.
  // Previously used String.length (UTF-16 code units), which let a manifest
  // packed with emoji or 4-byte UTF-8 sequences slip past at half the byte
  // cost. Buffer.byteLength is the right unit; the Next bodyParser cap
  // (64KB, set via export const config) is the outer wall.
  if (Buffer.byteLength(JSON.stringify(body.manifest), 'utf8') > 32_000) {
    res.status(413).json({ error: 'manifest exceeds 32KB' });
    return;
  }
  const appId = body.appId;

  const oauth = await dbRead.oauthClient.findUnique({
    where: { id: appId },
    select: { allowedScopes: true, allowedOrigins: true },
  });
  if (!oauth) {
    res.status(404).json({ error: 'OAuth client not found' });
    return;
  }

  const validation = BlockManifestValidator.validate(body.manifest, {
    allowedScopes: oauth.allowedScopes,
    allowedOrigins: oauth.allowedOrigins ?? [],
  });
  if (!validation.valid) {
    if (validation.errors.includes('INLINE_REQUIRES_VERIFIED_TIER')) {
      res.status(422).json({ error: 'INLINE_REQUIRES_VERIFIED_TIER', details: validation.errors });
      return;
    }
    res.status(422).json({ error: 'Invalid manifest', details: validation.errors });
    return;
  }

  const manifest = body.manifest as {
    blockId: string;
    version: string;
    contentRating: string;
    renderMode?: string;
    trustTier?: string;
  };

  // H-1: look up the existing row before the upsert so we can refuse
  // tier/render-mode changes from the manifest payload. Trust tier is
  // server-controlled — promoting it via manifest upload would bypass the
  // sandbox gate (verified/internal tiers can carry allow-same-origin).
  const existing = await dbRead.appBlock.findUnique({
    where: { appId_blockId: { appId, blockId: manifest.blockId } },
    select: { trustTier: true, renderMode: true, manifest: true, status: true, id: true },
  });

  if (existing) {
    const requestedTrust = manifest.trustTier ?? 'unverified';
    const requestedRender = manifest.renderMode ?? 'iframe';
    if (existing.trustTier !== requestedTrust) {
      res.status(403).json({
        error: 'trustTier changes are admin-only — manifest update rejected',
      });
      return;
    }
    if (existing.renderMode !== requestedRender) {
      res.status(403).json({
        error: 'renderMode changes are admin-only — manifest update rejected',
      });
      return;
    }

    // I11: if the new manifest is byte-equal to the existing row's manifest,
    // short-circuit. CI pipelines that re-upload on every deploy would
    // otherwise lose approval status to moderation on every push, even
    // though nothing changed. Compares canonical JSON to avoid spurious
    // mismatches from key order.
    //
    // Audit-9 #7: byte-equal INCLUDES the `version` field. A publisher
    // CI pipeline that auto-bumps version on every build without changing
    // anything semantic WILL trigger remoderation. That's intentional: a
    // version bump is the publisher's signal that something changed, so
    // moderators get a chance to re-review. CI pipelines that want to skip
    // remoderation must either keep the version stable across no-op pushes
    // OR get used to the latency between push and re-approval. Documented
    // in docs/features/app-blocks.md.
    const existingManifestJson = JSON.stringify(existing.manifest);
    const newManifestJson = JSON.stringify(body.manifest);
    if (existingManifestJson === newManifestJson) {
      res.status(200).json({ id: existing.id, status: existing.status, unchanged: true });
      return;
    }
  }

  const result = await dbWrite.appBlock.upsert({
    where: {
      appId_blockId: { appId, blockId: manifest.blockId },
    },
    create: {
      id: newAppBlockId(),
      appId,
      blockId: manifest.blockId,
      version: manifest.version,
      manifest: body.manifest as object,
      contentRating: manifest.contentRating,
      // M1 (audit): trustTier and renderMode are admin-controlled
      // privilege boundaries. Any publisher-supplied values are dropped
      // on insert — even on the JOB_TOKEN path. New rows start at
      // unverified/iframe; an admin tool (Phase 2) promotes via a
      // separate code path that's not reachable from the manifest API.
      // Without this, a JOB_TOKEN-holder could land trustTier='internal'
      // (which permits the allow-same-origin + allow-scripts sandbox
      // combo) and ship a manifest that escapes the iframe.
      renderMode: 'iframe',
      trustTier: 'unverified',
      // status defaults to 'pending' from the schema; new blocks never
      // render until a moderator approves.
    },
    update: {
      version: manifest.version,
      manifest: body.manifest as object,
      contentRating: manifest.contentRating,
      // H-1: re-enter moderation on every update. The publisher cannot
      // change iframe.src, sandbox, scopes, etc. without losing approval.
      status: 'pending',
      updatedAt: new Date(),
      // trustTier and renderMode intentionally omitted — they were
      // already validated against `existing` above, so the upsert keeps
      // the prior value. Admin tools update these separately.
    },
    select: { id: true, status: true },
  });

  // L3 (audit-10): every update demotes status to 'pending' (the H-1 fix).
  // Surface that fact in the response so publisher CI tooling can flag it
  // loudly instead of silently waiting for a moderator. `requiresReapproval`
  // is true on EVERY non-byte-equal update path; the byte-equal short-circuit
  // above returns `unchanged: true` instead.
  res.status(200).json({ ...result, requiresReapproval: true });
});
