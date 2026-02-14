import type { Availability, ModelStatus, ModelType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type {
  ModelVersionEarlyAccessConfig,
  RecommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import { createCachedArray } from '~/server/utils/cache-helpers';

export const resourceDataCache = createCachedArray({
  key: REDIS_KEYS.GENERATION.RESOURCE_DATA,
  cacheNotFound: false,
  lookupFn: async (ids) => {
    if (!ids.length) return {};
    const dbResults = await dbWrite.$queryRaw<GenerationResourceDataModel[]>`
      SELECT
        mv."id",
        mv."name",
        mv."trainedWords",
        mv."baseModel",
        mv."settings",
        mv."availability",
        mv."clipSkip",
        mv."vaeId",
        mv."status",
        (CASE WHEN mv."availability" = 'EarlyAccess' AND mv."earlyAccessEndsAt" >= NOW() THEN mv."earlyAccessConfig" END) as "earlyAccessConfig",
        gc."covered",
        FALSE AS "hasAccess",
        (
          SELECT to_json(obj)
          FROM (
            SELECT
              m."id",
              m."name",
              m."type",
              m."nsfw",
              m."poi",
              m."minor",
              m."userId",
              m."sfwOnly"
            FROM "Model" m
            WHERE m.id = mv."modelId"
          ) as obj
        ) as model
      FROM "ModelVersion" mv
      LEFT JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id
      WHERE mv.id IN (${Prisma.join(ids)})
    `;

    const results = dbResults.reduce<Record<number, GenerationResourceDataModel>>((acc, item) => {
      if (['Public', 'Unsearchable'].includes(item.availability) && item.status === 'Published')
        item.hasAccess = true;

      return { ...acc, [item.id]: item };
    }, {});
    return results;
  },
  idKey: 'id',
  dontCacheFn: (data) => {
    return !data.hasAccess || !data.covered;
  },
  ttl: CacheTTL.hour,
});

export type GenerationResourceDataModel = {
  id: number;
  name: string;
  trainedWords: string[];
  clipSkip: number | null;
  vaeId: number | null;
  baseModel: string;
  settings: RecommendedSettingsSchema | null;
  availability: Availability;
  earlyAccessConfig?: ModelVersionEarlyAccessConfig | null;
  covered: boolean | null;
  status: ModelStatus;
  hasAccess: boolean;
  epochNumber?: number;
  model: {
    id: number;
    name: string;
    type: ModelType;
    nsfw: boolean;
    poi: boolean;
    userId: number;
    minor?: boolean;
    sfwOnly?: boolean;
  };
};
