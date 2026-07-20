import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { exportUserBuzzTransactionsSchema } from '~/server/schema/buzz.schema';
import {
  assertValidTransactionRange,
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
  // `?type=` with no value must not coerce to 0 (Tip) and silently narrow the export.
  type: z.string().min(1).transform(Number).pipe(z.enum(TransactionType)).optional(),
});

// Fixed-window per-user limiter. Fails OPEN: a redis blip shouldn't block a
// read-only export of the caller's own data. Shares the trpc limit namespace
// rather than minting a key in the redis package for one endpoint.
async function underRateLimit(userId: number) {
  const key = `${REDIS_KEYS.TRPC.LIMIT.BASE}:buzz:export:${userId}`;
  try {
    const count = await redis.incrBy(key as never, 1);
    // The window must stay fixed: refreshing the TTL on every request would let
    // a user who retries through their 429s hold the counter open forever.
    // Repairing a missing TTL still covers a pod dying between INCR and EXPIRE.
    if (count === 1) await redis.expire(key as never, RATE_LIMIT_WINDOW_SECONDS);
    else if ((await redis.ttl(key as never)) < 0)
      await redis.expire(key as never, RATE_LIMIT_WINDOW_SECONDS);

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

    // Validate the range before spending any of the caller's hourly quota.
    try {
      assertValidTransactionRange(input.data);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    if (!(await underRateLimit(user.id)))
      return res.status(429).json({ error: "You're exporting too often. Try again later." });

    const filename = getTransactionExportFilename(input.data);

    try {
      for await (const chunk of streamUserBuzzTransactionsCsv({
        ...input.data,
        accountId: user.id,
      })) {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Cache-Control', 'private, no-store');
          // Chunked with no Content-Length: proxies and Chrome's download manager
          // both behave better when the headers are committed up front rather
          // than riding along with the first body write.
          res.flushHeaders();
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
        stack: (error as Error).stack,
        userId: user.id,
      }).catch(() => undefined);

      if (!res.headersSent)
        return res.status(500).json({ error: 'Could not export transactions right now.' });

      // The status is already committed, so ending normally would hand the user a
      // truncated CSV that looks complete. Destroying the socket aborts the
      // chunked response so the browser reports a failed download instead.
      return res.destroy();
    }

    return res.end();
  },
  ['GET']
);
