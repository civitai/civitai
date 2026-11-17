import type { NextApiRequest, NextApiResponse } from 'next';

import { dbRead } from '~/server/db/client';
import { appsDb } from '~/server/db/appsDb';
import { AppStorageProvisioner } from '~/server/services/apps/storage-provision.service';
import { sanitizeAppSlug } from '~/server/utils/apps-slug';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * App Blocks KV datastore backfill (W4-KV-v0). Walks every approved
 * `app_blocks` row and provisions its schema + role idempotently.
 *
 * Primary call path for new apps is the W2 webhook (push → build →
 * callback → provision). This endpoint is the safety net: re-run after
 * any rollout that might have raced provisioning, or to recover from a
 * cnpg-cluster-apps reset.
 *
 * Idempotent — every DDL statement in `AppStorageProvisioner.provision`
 * is IF NOT EXISTS / DO-block guarded, and the quota seed uses ON
 * CONFLICT. Safe to invoke at any cadence.
 *
 * Auth via the existing `WebhookEndpoint(?token=...)` gate (same as
 * sibling admin endpoints).
 *
 * Usage:
 *   GET /api/admin/apps-storage-backfill?token=<WEBHOOK_TOKEN>
 *     → list which approved apps need provisioning (dry run).
 *
 *   GET /api/admin/apps-storage-backfill?token=...&apply=true
 *     → provision the listed apps and return per-app status.
 *
 *   GET /api/admin/apps-storage-backfill?token=...&appBlockId=apb_xxx&apply=true
 *     → provision a single app (manual one-off).
 */
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (!appsDb) {
    res
      .status(503)
      .json({ ok: false, error: 'APPS_DATABASE_URL not configured — apps datastore unavailable' });
    return;
  }

  const apply = req.query.apply === 'true' || req.query.apply === '1';
  const targetAppBlockId =
    typeof req.query.appBlockId === 'string' && req.query.appBlockId.length > 0
      ? req.query.appBlockId
      : undefined;

  // Pull approved apps. status='approved' is the W2 contract — pending /
  // rejected apps don't get storage. Limit query to id + blockId; we
  // don't need the manifest for provisioning.
  const apps = await dbRead.appBlock.findMany({
    where: {
      status: 'approved',
      ...(targetAppBlockId ? { id: targetAppBlockId } : {}),
    },
    select: { id: true, blockId: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

  type Result = {
    appBlockId: string;
    blockId: string;
    slug: string | null;
    provisioned: boolean;
    error?: string;
  };

  const results: Result[] = [];

  for (const app of apps) {
    const slug = sanitizeAppSlug(app.blockId);
    if (!slug) {
      results.push({
        appBlockId: app.id,
        blockId: app.blockId,
        slug: null,
        provisioned: false,
        error: 'blockId does not normalize to a valid slug',
      });
      continue;
    }

    if (!apply) {
      // Dry-run: just enumerate.
      results.push({
        appBlockId: app.id,
        blockId: app.blockId,
        slug,
        provisioned: false,
      });
      continue;
    }

    try {
      await AppStorageProvisioner.provision({ appBlockId: app.id, slug });
      results.push({ appBlockId: app.id, blockId: app.blockId, slug, provisioned: true });
    } catch (err) {
      results.push({
        appBlockId: app.id,
        blockId: app.blockId,
        slug,
        provisioned: false,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  res.status(200).json({
    ok: true,
    apply,
    appsConsidered: apps.length,
    provisioned: results.filter((r) => r.provisioned).length,
    failures: results.filter((r) => r.error).length,
    results,
  });
});
