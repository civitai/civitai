import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  cursor: z.coerce.number().optional().default(0),
  batchSize: z.coerce.number().optional().default(50000),
});

const taskGenerators: ((ctx: MigrationContext) => Task)[] = [updatedAtFromCreatedAt];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  let { cursor } = params;
  const { batchSize } = params;
  const maxCursorQuery = await pgDbWrite.cancellableQuery<{ maxCursor: number }>(`
    SELECT MAX("id") as "maxCursor"
    FROM "Image";
  `);
  res.on('close', maxCursorQuery.cancel);
  const [{ maxCursor }] = await maxCursorQuery.result();
  console.log('Migrating imageMetrics:', maxCursor);

  let stop = false;
  const cancelFns: (() => void)[] = [];
  res.on('close', () => {
    stop = true;
    cancelFns.forEach((fn) => fn());
  });

  const tasks: Task[] = [];
  while (cursor <= maxCursor) {
    const start = cursor;
    cursor += batchSize;
    const end = Math.min(cursor, maxCursor);
    const ctx = { start, end, stop, cancelFns };

    for (const taskGenerator of taskGenerators) tasks.push(taskGenerator(ctx));
  }

  const start = Date.now();
  await limitConcurrency(tasks, 3);

  return res.status(200).json({
    ok: true,
    duration: (Date.now() - start) / 1000,
  });
});

type MigrationContext = {
  start: number;
  end: number;
  stop: boolean;
  cancelFns: (() => void)[];
};
function updatedAtFromCreatedAt(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    // updatedAtFromCreatedAt
    console.log('UpdatedAtFromCreatedAt ' + ctx.start + '-' + ctx.end);
    console.time('UpdatedAtFromCreatedAt ' + ctx.start + '-' + ctx.end);
    const query = await pgDbWrite.cancellableQuery(`
      -- updatedAtFromCreatedAt
      UPDATE "ImageMetric" SET "updatedAt" = "createdAt"
      WHERE "imageId" > ${ctx.start} AND "imageId" <= ${ctx.end} AND "createdAt" > '2024-02-22';
    `);
    ctx.cancelFns.push(query.cancel);
    await query.result();
    console.timeEnd('UpdatedAtFromCreatedAt ' + ctx.start + '-' + ctx.end);

    // createdAtFromImage
    if (ctx.stop) return;
    console.log('createdAtFromImage ' + ctx.start + '-' + ctx.end);
    console.time('createdAtFromImage ' + ctx.start + '-' + ctx.end);
    const query2 = await pgDbWrite.cancellableQuery(`
      -- createdAtFromImage
      UPDATE "ImageMetric" im SET "createdAt" = i."createdAt"
      FROM "Image" i
      WHERE i."id" = im."imageId"
        AND im."imageId" > ${ctx.start} AND im."imageId" <= ${ctx.end}
        AND im."createdAt" > '2024-02-22';
    `);
    ctx.cancelFns.push(query2.cancel);
    await query2.result();
    console.timeEnd('createdAtFromImage ' + ctx.start + '-' + ctx.end);
  };
}
