import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { notifDbWrite } from '~/server/db/notifDb';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { formatDateMin } from '~/utils/date-helpers';

const schema = z.object({
  before: z.coerce.date(),
  by: z.enum(['day', 'week', 'month']).default('month'),
});

// Run at 5:09 PM
const startDate = new Date('2022-12-30');
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  const { before, by } = params;

  let stop = false;
  const cancelFns: (() => void)[] = [];
  res.on('close', () => {
    stop = true;
    cancelFns.forEach((fn) => fn());
  });

  const tasks: Task[] = [];
  let cursor = startDate;
  while (cursor < before) {
    const start = cursor;
    let end = dayjs(cursor).add(1, by).startOf(by).toDate();
    if (end > before) end = before;
    tasks.push(async () => {
      if (stop) return;

      const logKey =
        'Deleting notifications ' + formatDateMin(start, false) + ' - ' + formatDateMin(end, false);
      console.log(logKey);
      console.time(logKey);

      const query = await notifDbWrite.cancellableQuery(Prisma.sql`
        DELETE
        FROM
          "UserNotification"
        WHERE
          "createdAt" BETWEEN '${start.toISOString()}' AND '${end.toISOString()}';
      `);
      cancelFns.push(query.cancel);
      await query.result();
      console.timeEnd(logKey);
    });
    cursor = end;
  }

  const start = Date.now();
  await limitConcurrency(tasks, 3);

  return res.status(200).json({
    ok: true,
    duration: (Date.now() - start) / 1000,
  });
});
