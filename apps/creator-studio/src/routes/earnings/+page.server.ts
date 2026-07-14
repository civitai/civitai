import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getEarningsSummary, getEarningsSeries, EARNINGS_RANGES } from '$lib/server/earnings';

const daysSchema = z.coerce
  .number()
  .int()
  .refine((n) => (EARNINGS_RANGES as readonly number[]).includes(n))
  .catch(30);
const granularitySchema = z.enum(['day', 'week']).catch('day');

export const load: PageServerLoad = async ({ locals, url }) => {
  const days = daysSchema.parse(url.searchParams.get('days') ?? undefined);
  const granularity = granularitySchema.parse(url.searchParams.get('g') ?? undefined);
  try {
    const [summary, series] = await Promise.all([
      getEarningsSummary({ userId: locals.user.id, days }),
      getEarningsSeries({ userId: locals.user.id, days, granularity }),
    ]);
    return { summary, series, days, granularity };
  } catch {
    // ClickHouse unreachable/misconfigured — degrade gracefully rather than 500 the page.
    return { summary: null, series: null, days, granularity };
  }
};
