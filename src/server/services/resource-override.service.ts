import { dbWrite } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';

async function getExistingResourceOverridesByModelIds({ modelIds }: { modelIds: number[] }) {
  return await dbWrite.$queryRaw<{ hash: string; modelVersionId: number }[]>`
    WITH model_file_hashes AS (
      SELECT
        lower(mfh.hash),
        mf."modelVersionId"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = 'Model'
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      WHERE mv."modelId" IN (${Prisma.join(modelIds)}) AND mfh.type = 'AutoV2'
      GROUP BY mfh.hash, mf."modelVersionId"
    )
    SELECT * FROM "ResourceOverride"
    WHERE hash IN (SELECT hash FROM model_file_hashes);
  `;
}

export async function createResourceOverridesByModelIds({ modelIds }: { modelIds: number[] }) {
  const results = await getExistingResourceOverridesByModelIds({ modelIds });

  if (results.length > 0)
    throw new Error(
      `Resource override already exists for model version(s): ${results
        .map((x) => x.modelVersionId)
        .join(', ')}`
    );

  await dbWrite.$queryRaw`
    INSERT INTO "ResourceOverride" ("hash", "modelVersionId", "type")
    SELECT
      lower(mfh.hash),
      mf."modelVersionId",
      mfh.type
    FROM "ModelFileHash" mfh
    JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = 'Model'
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    WHERE mv."modelId" IN (${Prisma.join(modelIds)}) AND mfh.type = 'AutoV2'
    GROUP BY mfh.hash, mf."modelVersionId";
  `;
}

async function getExistingResourceOverridesByModelVersionIds({
  modelVersionIds,
}: {
  modelVersionIds: number[];
}) {
  return await dbWrite.$queryRaw<{ hash: string; modelVersionId: number }[]>`
    WITH model_file_hashes AS (
      SELECT
      lower(mfh.hash),
      mf."modelVersionId"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = 'Model'
      WHERE mf."modelVersionId" IN (${Prisma.join(modelVersionIds)}) AND mfh.type = 'AutoV2'
      GROUP BY mfh.hash, mf."modelVersionId"
    )
    SELECT * FROM "ResourceOverride"
    WHERE hash IN (SELECT hash FROM model_file_hashes);
  `;
}

export async function createResourceOverridesByModelVersionIds({
  modelVersionIds,
}: {
  modelVersionIds: number[];
}) {
  const results = await getExistingResourceOverridesByModelVersionIds({ modelVersionIds });
  if (results.length > 0)
    throw new Error(
      `Resource override already exists for model version(s): ${results
        .map((x) => x.modelVersionId)
        .join(', ')}`
    );

  await dbWrite.$queryRaw`
    INSERT INTO "ResourceOverride" ("hash", "modelVersionId", "type")
    SELECT
      lower(mfh.hash),
      mf."modelVersionId",
      mfh.type
    FROM "ModelFileHash" mfh
    JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = 'Model'
    WHERE mf."modelVersionId" IN (${Prisma.join(modelVersionIds)}) AND mfh.type = 'AutoV2'
    GROUP BY mfh.hash, mf."modelVersionId";
  `;
}

export async function getResourceOverrides(hashes: string[]) {
  return await dbWrite.$queryRaw<{ modelVersionId: number; hash: string; type: ModelHashType }>`
    SELECT * FROM "ResourceOverride"
    WHERE "hash" IN (${Prisma.join(hashes.map((hash) => hash.toLowerCase()))})
  `;
}

// type ResourceOverride = { modelVersionId: number; hash: string; type: ModelHashType };
// export const resourceOverrideCache = createCachedObject({
//   key: REDIS_KEYS.CACHES.RESOURCE_OVERRIDES,
//   idKey: 'hash',
//   lookupFn: async (hashes) => {
//     const overrides = await dbWrite.$queryRaw<ResourceOverride[]>`
//       SELECT * FROM "ResourceOverride"
//       WHERE "hash" IN (${Prisma.join(hashes.map((hash) => hash.toLowerCase()))})
//     `;
//     return overrides;
//     return Object.fromEntries(overrides.map((x) => [x.hash, x]));
//   },
//   ttl: CacheTTL.hour,
// });
