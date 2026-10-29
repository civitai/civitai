import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { publishModelById } from '~/server/services/model.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { notRemovedWithOwnerSql } from '~/server/utils/legal-hold';
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
    -- A model a content wipe kept is a moderator's to restore.
    AND ${notRemovedWithOwnerSql('m.meta').sql}
    -- Both encodings: take-downs before the single-statement rewrite left the version at
    -- 'Unpublished' with a reason in meta; after it, a reasoned take-down writes
    -- 'UnpublishedViolation'. Matching only the first silently restores an arbitrary subset —
    -- the older rows — and reports 200 either way.
    AND mv."status" IN ('Unpublished', 'UnpublishedViolation')
    GROUP BY 1, 2
  `);

  const tasks = versions.map(({ id, versionIds }, i) => async () => {
    const consoleKey = `Republishing ${i + 1} of ${versions.length}`;
    console.time(consoleKey);
    // A content wipe may have kept the model since the select: the publish refuses it under its lock.
    await publishModelById({
      id,
      versionIds,
      republishing: true,
      refuseRemovedWithOwner: true,
      meta: (stored) => {
        const { needsReview, unpublishedReason, unpublishedAt, customMessage, ...meta } =
          stored || {};
        return meta;
      },
    }).catch((error) => {
      if (error instanceof TRPCError && error.code === 'UNAUTHORIZED') return;
      throw error;
    });
    console.timeEnd(consoleKey);
  });
  await limitConcurrency(tasks, 10);

  return res.status(200).json(versions);
});
