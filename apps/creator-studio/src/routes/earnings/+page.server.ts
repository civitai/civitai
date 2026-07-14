import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getEarningsSummary, getEarningsSeries, EARNINGS_RANGES } from '$lib/server/earnings';
import { getCreatorCash } from '$lib/server/cash';

const daysSchema = z.coerce
  .number()
  .int()
  .refine((n) => (EARNINGS_RANGES as readonly number[]).includes(n))
  .catch(30);
const granularitySchema = z.enum(['day', 'week']).catch('day');

export const load: PageServerLoad = async ({ locals, url }) => {
  const days = daysSchema.parse(url.searchParams.get('days') ?? undefined);
  const granularity = granularitySchema.parse(url.searchParams.get('g') ?? undefined);
  // Earnings (ClickHouse) and cash balances (buzz service) come from different sources and degrade independently.
  const userId = locals.user.id;
  const [earnings, cash] = await Promise.all([
    Promise.all([
      getEarningsSummary({ userId, days }),
      getEarningsSeries({ userId, days, granularity }),
    ]).catch(() => [null, null] as const),
    getCreatorCash({ userId }).catch(() => null),
  ]);
  const [summary, series] = earnings;
  return { summary, series, cash, days, granularity };
};
