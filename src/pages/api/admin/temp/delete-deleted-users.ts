import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbWrite } from '~/server/db/client';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(50),
  batchSize: z.coerce.number().min(0).optional().default(10),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('TIMER');
  await action(req, res);
  console.timeEnd('TIMER');
  res.status(200).json({ finished: true });
});

async function action(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await batchProcessor({
    params,
    runContext: res,
    batchFetcher: async (context) => {
      const query = await pgDbRead.cancellableQuery(`
        SELECT
          id
        FROM temp_deleted_users t
        WHERE EXISTS (SELECT 1 FROM "User" u WHERE u.id = t.id)
        ORDER BY 1;
      `);
      context.cancelFns.push(query.cancel);
      const results = await query.result();
      return results.map((r) => r.id);
    },
    processor: async ({ batch, cancelFns, batchNumber, batchCount }) => {
      if (!batch.length) return;

      try {
        for (const [table, column] of Object.entries(referencedTables)) {
          const columnNames = Array.isArray(column) ? column : [column];
          for (const columnName of columnNames) {
            console.log(`${batchNumber} of ${batchCount}: Deleting from ${table} - ${columnName}`);
            await dbWrite.$executeRawUnsafe(`
              DELETE
              FROM "${table}"
              WHERE "${columnName}" IN (${batch});
            `);
            console.log(`${batchNumber} of ${batchCount}: Deleted from ${table} - ${columnName}`);
          }
        }
        console.log(`${batchNumber} of ${batchCount}: Deleted ${batchNumber} of ${batchCount}`);
      } catch (error) {
        console.error(`Failed to delete batch ${batchNumber} of ${batchCount}`);
      }
    },
  });
}

const referencedTables: Record<string, string | string[]> = {
  // ChatMember: 'userId',
  // PostReaction: 'userId',
  // CommentReaction: 'userId',
  // ImageReaction: 'userId',
  // Model: ['deletedBy', 'userId'],
  // UserCosmetic: 'userId',
  // CollectionItem: 'reviewedById',
  // Report: 'userId',
  // Post: 'userId',
  User: 'id',
};
