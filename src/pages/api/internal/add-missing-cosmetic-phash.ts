import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { getPerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const schema = z.object({
  limit: z.coerce.number().min(1).max(5000).optional(),
  concurrency: z.coerce.number().min(1).max(20).optional(),
  cosmeticId: z.coerce.number().optional(),
  dryRun: z.coerce.boolean().optional(),
});

type CosmeticRow = { id: number; url: string; animated: boolean };

export default ModEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { limit = 1000, concurrency = 5, cosmeticId, dryRun } = schema.parse(req.query);
  const start = Date.now();

  // Type isn't a reliable filter — NamePlate and ContentDecoration are CSS-only,
  // but the presence of `data.url` is what actually decides whether there's art.
  const records = await dbRead.$queryRaw<CosmeticRow[]>`
    SELECT
      id,
      data->>'url' as url,
      COALESCE((data->>'animated')::boolean, false) as animated
    FROM "Cosmetic"
    WHERE "pHash" IS NULL
      AND data->>'url' IS NOT NULL
      ${cosmeticId ? Prisma.sql`AND id = ${cosmeticId}` : Prisma.empty}
    ORDER BY id
    LIMIT ${limit}
  `;

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      pending: records.length,
      animated: records.filter((x) => x.animated).length,
    });
  }

  let hashed = 0;
  const failures: Array<{ id: number; animated: boolean }> = [];

  await limitConcurrency(
    records.map((record) => async () => {
      const pHash = await getPerceptualHash(record.url);
      if (!pHash) {
        failures.push({ id: record.id, animated: record.animated });
        return;
      }
      await dbWrite.cosmetic.update({ where: { id: record.id }, data: { pHash } });
      hashed++;
    }),
    concurrency
  );

  return res.status(200).json({
    considered: records.length,
    hashed,
    failed: failures.length,
    // Split out because animated artwork is the open question — if mediaHash
    // can't hash it, the failures cluster here rather than spreading evenly.
    failedAnimated: failures.filter((x) => x.animated).length,
    failedIds: failures.slice(0, 50).map((x) => x.id),
    duration: Date.now() - start,
  });
});
