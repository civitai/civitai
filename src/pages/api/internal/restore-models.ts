import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbWrite } from '~/server/db/client';
import { ModelMeta } from '~/server/schema/model.schema';
import { publishModelById } from '~/server/services/model.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { JobEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  modelIds: z.number().array(),
});

export default JobEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { modelIds } = schema.parse(req.query);

  const versions = await dbWrite.$queryRawUnsafe<
    { id: number; meta: ModelMeta; versionIds: number[] }[]
  >(`
    SELECT
      mv."modelId" as id,
      m.meta,
      array_agg(mv.id) as "versionIds"
    FROM "ModelVersion" mv
    JOIN "Model" m ON mv."modelId" = m.id
    WHERE mv."modelId" IN (${modelIds.join(',')})
    AND jsonb_typeof(mv.meta->'unpublishedAt') != 'undefined'
    AND (mv.meta->>'unpublishedReason') = 'duplicate'
    AND mv."status" = 'Unpublished'
    GROUP BY 1, 2
  `);

  const tasks = versions.map(({ id, meta: modelMeta, versionIds }, i) => async () => {
    const { needsReview, unpublishedReason, unpublishedAt, customMessage, ...meta } =
      modelMeta || {};
    const consoleKey = `Republishing ${i + 1} of ${versions.length}`;
    console.time(consoleKey);
    await publishModelById({
      id,
      versionIds,
      republishing: true,
      meta,
    });
    console.timeEnd(consoleKey);
  });
  await limitConcurrency(tasks, 10);

  return res.status(200).json(versions);
});
