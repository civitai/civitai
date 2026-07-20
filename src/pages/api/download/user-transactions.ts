import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { exportUserBuzzTransactionsSchema } from '~/server/schema/buzz.schema';
import {
  getTransactionExportFilename,
  streamUserBuzzTransactionsCsv,
} from '~/server/services/buzz.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { logToAxiom } from '~/server/logging/client';
import { TransactionType, buzzSpendTypes } from '~/shared/constants/buzz.constants';

export const config = {
  api: { responseLimit: false },
};

const EXPORTS_PER_HOUR = 10;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

const querySchema = z.object({
  accountTypes: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(buzzSpendTypes)).min(1)),
  start: z.coerce.date(),
  end: z.coerce.date(),
  type: z.coerce.number().pipe(z.enum(TransactionType)).optional(),
});

// Fixed-window per-user limiter. Fails OPEN: a redis blip shouldn't block a
// read-only export of the caller's own data. Shares the trpc limit namespace
// rather than minting a key in the redis package for one endpoint.
async function underRateLimit(userId: number) {
  const key = `${REDIS_KEYS.TRPC.LIMIT.BASE}:buzz:export:${userId}`;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) await redis.expire(key as never, RATE_LIMIT_WINDOW_SECONDS);
    return count <= EXPORTS_PER_HOUR;
  } catch {
    return true;
  }
}

export default AuthedEndpoint(
  async function downloadUserTransactions(req: NextApiRequest, res: NextApiResponse, user) {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid parameters' });

    const input = exportUserBuzzTransactionsSchema.safeParse(parsed.data);
    if (!input.success) return res.status(400).json({ error: 'Invalid parameters' });

    if (!(await underRateLimit(user.id)))
      return res.status(429).json({ error: "You're exporting too often. Try again later." });

    const filename = getTransactionExportFilename(input.data);

    try {
      // Headers go out before the first chunk, so any failure after this point
      // can only truncate the download — it can't be turned into a JSON error.
      for await (const chunk of streamUserBuzzTransactionsCsv({
        ...input.data,
        accountId: user.id,
      })) {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Cache-Control', 'private, no-store');
          // Excel reads a UTF-8 CSV as the system codepage without a BOM.
          res.write('\ufeff');
        }
        res.write(chunk);
      }
    } catch (error) {
      logToAxiom({
        name: 'buzz-transactions-export',
        type: 'error',
        message: (error as Error).message,
        userId: user.id,
      });
      if (!res.headersSent)
        return res.status(400).json({ error: (error as Error).message ?? 'Export failed' });
    }

    return res.end();
  },
  ['GET']
);
