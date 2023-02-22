import { Partner } from '@prisma/client';
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
    const results = schema.safeParse(req.body);
    if (!results.success) return res.status(420).json({ error: `Invalid supported model format` });

    // Clear previous entries
    await dbWrite.runStrategy.deleteMany({ where: { partnerId: partner.id } });

    // Set new entries
    await dbWrite.runStrategy.createMany({
      data: results.data.map(({ modelVersionId, runUrl: url }) => ({
        modelVersionId,
        url,
        partnerId: partner.id,
      })),
    });

    res.status(200).json({
      success: true,
      entryCount: results.data.length,
    });
  },
  ['POST']
);
