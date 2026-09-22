/**
 * Debug endpoint for orchestrator-loaded state on ModelVersion.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param
 * (not Bearer header — see TokenSecuredEndpoint). Not reachable without the
 * secret; no public UI.
 *
 * Usage:
 *   POST /api/testing/generator-loaded?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions (see the switch below for the authoritative param list):
 *   status - {modelVersionIds}  Current `generatorLoaded` for each version
 *   mark   - {modelVersionIds}  Set it — the sync job clears it next cycle unless actually resident
 *   clear  - {modelVersionIds}  Unset it — the sync job restores it next cycle if actually resident
 *
 * `mark` and `clear` queue a models search-index update, as the sync job does.
 * Changes are scoped to explicit version ids, capped at 200 per call, with no
 * unscoped wipe, so a misuse never cascades across the DB.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { uniq } from 'lodash-es';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  action: z.enum(['status', 'mark', 'clear']),
  modelVersionIds: z.array(z.coerce.number().int().positive()).min(1).max(200),
});

async function queueModelsFor(modelVersionIds: number[]) {
  const versions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: { modelId: true },
  });
  const modelIds = uniq(versions.map((x) => x.modelId));
  await modelsSearchIndex.queueUpdate(
    modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
  return modelIds.length;
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  }

  const { action } = parsed.data;
  const ids = uniq(parsed.data.modelVersionIds);

  if (action === 'status') {
    const versions = await dbRead.modelVersion.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, modelId: true, generatorLoaded: true },
    });
    return res.status(200).json({
      action,
      missing: ids.filter((id) => !versions.some((v) => v.id === id)),
      versions,
    });
  }

  // Raw SQL, as in the sync job, so a debug write does not bump ModelVersion."updatedAt".
  const updated = await dbWrite.$executeRaw`
    UPDATE "ModelVersion" SET "generatorLoaded" = ${action === 'mark'}
    WHERE id = ANY(${ids}::int[])
  `;
  const modelsQueued = await queueModelsFor(ids);

  return res.status(200).json({ action, updated, modelsQueued });
});
