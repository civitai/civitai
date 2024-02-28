import { Partner, Prisma } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { PartnerEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { chunk } from 'lodash-es';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

const schema = z
  .object({
    modelVersionId: z.preprocess((val) => Number(val), z.number()),
    runUrl: z.string().url().optional(),
  })
  .array();

export default PartnerEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, partner: Partner) {
    const results = schema.safeParse(req.body);
    if (!results.success) return res.status(420).json({ error: `Invalid supported model format` });
    const method = req.method as 'POST' | 'PUT' | 'DELETE';

    // Clear previous entries
    if (method === 'DELETE') {
      const modelVersionIds = results.data.map((x) => x.modelVersionId);
      await dbWrite.runStrategy.deleteMany({
        where: { partnerId: partner.id, modelVersionId: { in: modelVersionIds } },
      });
    } else if (method === 'POST')
      await dbWrite.runStrategy.deleteMany({ where: { partnerId: partner.id } });

    if (method !== 'DELETE') {
      // Split into batches of 1000
      const batches = chunk(
        results.data.filter((x) => x.runUrl != null),
        1000
      );

      for (const batch of batches) {
        // Set new entries
        await dbWrite.$executeRaw`
          INSERT INTO "RunStrategy" ("modelVersionId", "url", "partnerId")
          SELECT "modelVersionId", "url", "partnerId"
          FROM (
            VALUES ${Prisma.join(
              batch.map(
                ({ modelVersionId, runUrl }) =>
                  Prisma.sql`(${modelVersionId}, ${runUrl}, ${partner.id})`
              )
            )}
          ) t ("modelVersionId", "url", "partnerId")
          JOIN "ModelVersion" mv ON mv.id = t."modelVersionId"
          JOIN "Model" m ON m.id = mv."modelId"
          WHERE m."allowCommercialUse" && ARRAY['Rent'::"CommercialUse", 'Sell'::"CommercialUse"]
          ON CONFLICT ("partnerId", "modelVersionId") DO UPDATE SET "url" = excluded."url"
        `;
      }
    }

    const track = new Tracker(req, res);
    track.partnerEvent({
      type: 'Update',
      partnerId: partner.id,
    });

    res.status(200).json({
      success: true,
      entryCount: results.data.length,
    });
  },
  ['POST', 'PUT', 'DELETE']
);
