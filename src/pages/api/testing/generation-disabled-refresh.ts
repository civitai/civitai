/**
 * Debug endpoint: refresh caches + search index for versions carrying the
 * `ModelVersionFlag.DisableGeneration` bit.
 * =============================================================================
 *
 * Why this exists: the DisableGeneration flag is baked into cached version/model
 * rows (`resourceDataCache`, `dataForModelsCache`) and into the models search
 * index doc's `canGenerate`. `toggleUnavailableResource` refreshes all of that
 * via `bustMvCache`. Bits set DIRECTLY in the DB (a manual `UPDATE ... SET flags`)
 * bypass that, so those versions keep serving stale "generatable" data until the
 * caches expire (1h / 24h) — and the search doc never self-corrects at all.
 *
 * Run this once after any manual flag write.
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param.
 *
 * Usage:
 *   GET /api/testing/generation-disabled-refresh?token=$WEBHOOK_TOKEN
 *     Refresh every version currently carrying the flag.
 *
 *   GET /api/testing/generation-disabled-refresh?token=$WEBHOOK_TOKEN&dryRun=true
 *     Report what would be touched; changes nothing.
 *
 *   GET /api/testing/generation-disabled-refresh?token=$WEBHOOK_TOKEN&ids=123,456
 *     Refresh specific model-version ids instead (skips the table scan, and works
 *     for versions whose flag you just CLEARED — those no longer match the query).
 *
 * `bustMvCache` does both jobs: it busts resourceDataCache / dataForModelsCache /
 * modelVersionAccessCache / imagesForModelVersionsCache / the orchestrator + public
 * model-response caches, AND enqueues a models search-index update per model. The
 * Meilisearch write lands when the `search-index-sync` job next drains the queue.
 *
 * Not covered: the event-engine `model:full-data` cache (separate Redis namespace,
 * 24h TTL) — its feed `canGenerate` self-corrects on expiry.
 *
 * Safe to re-run: busting/enqueuing is idempotent.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { bustMvCache } from '~/server/services/model-version.service';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  ids: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(',')
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isInteger(x) && x > 0)
        : undefined
    ),
  dryRun: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => val === 'true'),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ids, dryRun } = parsed.data;

  // Explicit ids skip the scan; otherwise find everything carrying the flag.
  // No index backs this predicate (the per-row check made one unnecessary), so
  // it's a single seq scan — fine for a one-off admin call, not for a hot path.
  const versions = ids?.length
    ? await dbRead.$queryRaw<{ id: number; modelId: number }[]>`
        SELECT "id", "modelId" FROM "ModelVersion" WHERE "id" = ANY(${ids})
      `
    : await dbRead.$queryRaw<{ id: number; modelId: number }[]>`
        SELECT "id", "modelId" FROM "ModelVersion"
        WHERE (flags & ${ModelVersionFlag.DisableGeneration}) <> 0
      `;

  const versionIds = versions.map((v) => v.id);
  const modelIds = [...new Set(versions.map((v) => v.modelId))];

  if (!versionIds.length) {
    return res.status(200).json({ dryRun, versionCount: 0, modelCount: 0, versionIds, modelIds });
  }

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      versionCount: versionIds.length,
      modelCount: modelIds.length,
      versionIds,
      modelIds,
    });
  }

  await bustMvCache(versionIds, modelIds);

  return res.status(200).json({
    dryRun: false,
    versionCount: versionIds.length,
    modelCount: modelIds.length,
    versionIds,
    modelIds,
  });
});
