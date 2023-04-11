import { Partner, Prisma } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { PartnerEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';

const runStrategySchema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  runUrl: z.string().url(),
});
const schema = z.array(runStrategySchema);

export default PartnerEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, partner: Partner) {
    console.log(partner.id);
    const results = schema.safeParse(req.body);
    if (!results.success) return res.status(420).json({ error: `Invalid supported model format` });

    // Clear previous entries
    await dbWrite.runStrategy.deleteMany({ where: { partnerId: partner.id } });

    // Set new entries
    await dbWrite.$executeRaw`
      INSERT INTO "RunStrategy" ("modelVersionId", "url", "partnerId")
      SELECT "modelVersionId", "url", "partnerId"
      FROM (
        VALUES ${Prisma.join(
          results.data.map(
            ({ modelVersionId, runUrl }) =>
              Prisma.sql`(${modelVersionId}, ${runUrl}, ${partner.id})`
          )
        )}
      ) t ("modelVersionId", "url", "partnerId")
      JOIN "ModelVersion" mv ON mv.id = t."modelVersionId"
      ON CONFLICT DO NOTHING;
    `;

    res.status(200).json({
      success: true,
      entryCount: results.data.length,
    });
  },
  ['POST']
);
