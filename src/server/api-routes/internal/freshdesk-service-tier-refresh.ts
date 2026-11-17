import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { syncFreshdeskMembership } from '~/server/services/subscriptions.service';
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

  const rows = await dbWrite.$queryRawUnsafe<{ userId: number }[]>(`
    SELECT DISTINCT cs."userId"
    FROM "CustomerSubscription" cs
    JOIN "User" u ON u.id = cs."userId"
    WHERE cs.status NOT IN ('canceled', 'incomplete_expired', 'past_due', 'unpaid')
    AND u.email IS NOT NULL
    ${start ? `AND cs."userId" > ${start}` : ''}
    ORDER BY cs."userId" ASC
  `);

  let processed = 0;
  const tasks = rows.map(({ userId }) => async () => {
    processed++;
    const consoleKey = `${userId}: syncFreshdeskMembership ${processed} of ${rows.length}`;
    console.time(consoleKey);
    await syncFreshdeskMembership({ userId }).catch((err) => {
      console.error(`Failed to sync userId=${userId}:`, (err as Error).message);
    });
    console.timeEnd(consoleKey);
  });
  await limitConcurrency(tasks, 5);

  return res.status(200).json({ count: rows.length });
});
