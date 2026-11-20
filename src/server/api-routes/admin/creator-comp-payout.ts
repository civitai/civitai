import type { NextApiRequest, NextApiResponse } from 'next';
import dayjs from 'dayjs';
import * as z from 'zod';
import { runPayout } from '~/server/jobs/deliver-creator-compensation';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const MAX_DAYS = 120;

const schema = z
  .object({
    date: z.coerce.date().optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  })
  .superRefine((val, ctx) => {
    const hasSingle = !!val.date;
    const hasRange = !!val.startDate && !!val.endDate;
    if (!hasSingle && !hasRange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either `date`, or both `startDate` and `endDate`',
      });
      return;
    }
    if (hasRange && val.endDate! < val.startDate!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDate must be on or after startDate',
        path: ['endDate'],
      });
    }
  });

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { date, startDate, endDate } = parsed.data;

  if (date) {
    await runPayout(date);
    return res.status(200).json({ ok: true, days: 1 });
  }

  const days: Date[] = [];
  let cursor = dayjs.utc(startDate!).startOf('day');
  const stop = dayjs.utc(endDate!).startOf('day');
  while (!cursor.isAfter(stop)) {
    days.push(cursor.toDate());
    cursor = cursor.add(1, 'day');
  }
  if (days.length > MAX_DAYS) {
    return res
      .status(400)
      .json({ error: `Date range too large: ${days.length} days exceeds limit of ${MAX_DAYS}` });
  }

  const results: { date: string; ok: boolean; error?: string }[] = [];
  for (const day of days) {
    const iso = dayjs.utc(day).format('YYYY-MM-DD');
    try {
      await runPayout(day);
      results.push({ date: iso, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[creator-comp-payout] runPayout failed for ${iso}:`, err);
      results.push({ date: iso, ok: false, error: message });
    }
  }

  return res.status(200).json({
    ok: results.every((r) => r.ok),
    days: results.length,
    okCount: results.filter((r) => r.ok).length,
    failures: results.filter((r) => !r.ok),
  });
});
