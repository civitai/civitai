import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { exportUserBuzzTransactionsSchema } from '~/server/schema/buzz.schema';
import {
  assertValidTransactionRange,
  getTransactionRangeMonths,
  getTransactionExportFilename,
  streamUserBuzzTransactionsCsv,
} from '~/server/services/buzz.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { logToAxiom } from '~/server/logging/client';
import { TransactionType, buzzSpendTypes } from '~/shared/constants/buzz.constants';

export const config = {
  api: { responseLimit: false },
};

// Cost-weighted rather than a flat request count: one month of history is one
// pair of projection-backed queries, an all-time export is thirty-odd. The
// budget is spent in month-units so a wide range costs proportionally more,
// and a user pulling single months isn't punished for the shape of someone
// else's request. 60 units ~= sixty one-month exports, or two all-time ones.
const EXPORT_BUDGET_PER_HOUR = 60;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

const querySchema = z.object({
  accountTypes: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(buzzSpendTypes)).min(1)),
  start: z.coerce.date(),
  end: z.coerce.date(),
  // Digits only. `min(1)` counts characters, so ' ', '0x2' and '1e1' all pass it
  // and Number(' ') is 0 — silently narrowing the export to Tips.
  type: z.string().regex(/^\d+$/).transform(Number).pipe(z.enum(TransactionType)).optional(),
});

// Fixed-window per-user limiter. Fails OPEN: a redis blip shouldn't block a
// read-only export of the caller's own data. Shares the trpc limit namespace
// rather than minting a key in the redis package for one endpoint.
const budgetKey = (userId: number) => `${REDIS_KEYS.TRPC.LIMIT.BASE}:buzz:export:${userId}`;

// Read-only: lets the probe predict a 429 without spending anything.
async function exportBudgetSpent(userId: number) {
  try {
    return Number(await redis.get(budgetKey(userId) as never)) || 0;
  } catch {
    return 0;
  }
}

async function chargeExportBudget(userId: number, cost: number) {
  const key = budgetKey(userId);
  try {
    const count = await redis.incrBy(key as never, cost);
    // The window must stay fixed: refreshing the TTL on every request would let
    // a user who retries through their 429s hold the counter open forever.
    // Repairing a missing TTL still covers a pod dying between INCR and EXPIRE.
    if (count === 1) await redis.expire(key as never, RATE_LIMIT_WINDOW_SECONDS);
    else if ((await redis.ttl(key as never)) < 0)
      await redis.expire(key as never, RATE_LIMIT_WINDOW_SECONDS);

    return count <= EXPORT_BUDGET_PER_HOUR;
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

    const months = getTransactionRangeMonths(input.data);

    const overBudget = `You've exported a lot of history in the past hour. Wait a bit, or pick a narrower date range — this one covers ${months} month${
      months === 1 ? '' : 's'
    }.`;

    // A download triggered by <a download> has no way to show the user a server
    // error, so the UI probes first. The probe spends nothing and only predicts.
    if (req.query.probe) {
      if ((await exportBudgetSpent(user.id)) + months > EXPORT_BUDGET_PER_HOUR)
        return res.status(429).json({ error: overBudget });

      return res.status(200).json({ ok: true, months });
    }

    if (!(await chargeExportBudget(user.id, months)))
      return res.status(429).json({ error: overBudget });

    const filename = getTransactionExportFilename(input.data);

    try {
      for await (const chunk of streamUserBuzzTransactionsCsv({
        ...input.data,
        accountId: user.id,
      })) {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          // no-transform and X-Accel-Buffering match the SSE endpoint in
          // api/admin/clear-cache-by-pattern: without them an nginx-family proxy
          // buffers the whole body before forwarding a byte, which holds the
          // entire CSV in memory one hop out and undoes the streaming.
          res.setHeader('Cache-Control', 'private, no-store, no-transform');
          res.setHeader('X-Accel-Buffering', 'no');
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
