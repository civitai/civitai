import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { upsertContact } from '~/server/integrations/freshdesk';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { JobEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  start: z.coerce.number().optional(),
});

export default JobEndpoint(async function freshdeskServiceTierRefresh(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { start } = schema.parse(req.query);

  const members = await dbWrite.$queryRawUnsafe<
    { id: number; username: string; email: string; tier: string }[]
  >(`
    SELECT
      u.id,
      u.username,
      u.email,
      REPLACE(p.name, ' Tier', '') as tier
    FROM "CustomerSubscription" cs
    JOIN "Product" p ON p.id = cs."productId"
    JOIN "User" u on u.id = cs."userId"
    WHERE status = 'active'
    AND p.name != 'Save Card Details'
    AND u.email IS NOT NULL
    ${start ? `AND cs."userId" > ${start}` : ''}
    ORDER BY cs."userId" ASC
  `);

  let processed = 0;
  const tasks = members.map((data) => async () => {
    processed++;
    const consoleKey = `${data.id}: updateServiceTier ${processed} of ${members.length}`;
    console.time(consoleKey);
    await upsertContact(data);
    console.timeEnd(consoleKey);
  });
  await limitConcurrency(tasks, 5);

  return res.status(200).json({ count: members.length });
});
