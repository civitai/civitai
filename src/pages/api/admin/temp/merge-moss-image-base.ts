/**
 * One-time endpoint for the MOSS Image Base -> MOSS Image merge: the two releases turned out to
 * share LoRAs, so the `MossImage_base` ecosystem and the 'MOSS Image Base' base model were folded
 * into `MossImage` / 'MOSS Image'. Run it right after that deploy lands; until it runs, every
 * version still labelled 'MOSS Image Base' carries a name the server no longer knows.
 *
 * Why an endpoint instead of raw SQL: the relabelled versions sit in the resource-data and
 * orchestrator caches for up to an hour and in the models search index until reindexed, so the
 * busts and the index queue have to follow the UPDATE in the same run.
 *
 * Writes (idempotent — a second run finds nothing to relabel):
 *   - ModelVersion.baseModel 'MOSS Image Base' -> 'MOSS Image'
 *   - EcosystemCheckpoints.name for the Base checkpoint's coverage row
 *   - GenerationBaseModel row 'MOSS Image Base' deleted
 *   - GenerationPreset rows on `MossImage_base`: ecosystem column and the saved values
 *     (base-model label and AIR namespace) rewritten
 * Then bustMvCache + a models search-index update for every relabelled version.
 *
 * Run with:
 *   POST /api/admin/temp/merge-moss-image-base?token=$WEBHOOK_TOKEN              (dry run)
 *   POST /api/admin/temp/merge-moss-image-base?token=$WEBHOOK_TOKEN&dryRun=false
 */

import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { bustMvCache } from '~/server/services/model-version.service';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

const OLD_BASE_MODEL = 'MOSS Image Base';
const NEW_BASE_MODEL = 'MOSS Image';
const OLD_ECOSYSTEM_KEY = 'MossImage_base';
const NEW_ECOSYSTEM_KEY = 'MossImage';
const OLD_AIR_PREFIX = 'urn:air:mossimage_base:';
const NEW_AIR_PREFIX = 'urn:air:mossimage:';

const schema = z.object({ dryRun: booleanString().default(true) });

type Result = {
  versions: { id: number; modelId: number }[];
  relabelledVersions: number;
  relabelledCoverageRows: number;
  deletedGenerationBaseModels: number;
  rewrittenPresets: number;
};

class DryRunRollback extends Error {
  constructor(public readonly result: Result) {
    super('dry-run rollback');
  }
}

async function relabel(dryRun: boolean): Promise<Result> {
  return dbWrite.$transaction(
    async (tx) => {
      const versions = await tx.$queryRaw<{ id: number; modelId: number }[]>`
        SELECT id, "modelId" FROM "ModelVersion" WHERE "baseModel" = ${OLD_BASE_MODEL}
      `;
      const relabelledVersions = await tx.$executeRaw`
        UPDATE "ModelVersion" SET "baseModel" = ${NEW_BASE_MODEL}
        WHERE "baseModel" = ${OLD_BASE_MODEL}
      `;
      const relabelledCoverageRows = await tx.$executeRaw`
        UPDATE "EcosystemCheckpoints" SET name = ${NEW_BASE_MODEL} WHERE name = ${OLD_BASE_MODEL}
      `;
      const deletedGenerationBaseModels = await tx.$executeRaw`
        DELETE FROM "GenerationBaseModel" WHERE "baseModel" = ${OLD_BASE_MODEL}
      `;
      const rewrittenPresets = await tx.$executeRaw`
        UPDATE "GenerationPreset"
        SET ecosystem = ${NEW_ECOSYSTEM_KEY},
            "values" = replace(
              replace("values"::text, ${`"${OLD_BASE_MODEL}"`}, ${`"${NEW_BASE_MODEL}"`}),
              ${OLD_AIR_PREFIX}, ${NEW_AIR_PREFIX}
            )::jsonb
        WHERE ecosystem = ${OLD_ECOSYSTEM_KEY}
      `;

      const result: Result = {
        versions,
        relabelledVersions,
        relabelledCoverageRows,
        deletedGenerationBaseModels,
        rewrittenPresets,
      };
      if (dryRun) throw new DryRunRollback(result);
      return result;
    },
    { timeout: 60 * 1000 }
  );
}

const counts = ({ versions, ...rest }: Result) => rest;

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.treeifyError(parsed.error) });
  const { dryRun } = parsed.data;

  let result: Result;
  try {
    result = await relabel(dryRun);
  } catch (error) {
    if (error instanceof DryRunRollback) {
      return res.status(200).json({ dryRun: true, ...counts(error.result) });
    }
    return handleEndpointError(res, error);
  }

  if (result.versions.length) {
    await bustMvCache(
      result.versions.map((v) => v.id),
      Array.from(new Set(result.versions.map((v) => v.modelId)))
    );
  }

  return res.status(200).json({ dryRun: false, ...counts(result), busted: result.versions.length });
});
