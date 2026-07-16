import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getContentAnalytics, getAllTimeTotals, ANALYTICS_RANGES } from '$lib/server/analytics';
import { getModelEarnings } from '$lib/server/models-earnings';

const daysSchema = z.coerce
  .number()
  .int()
  .refine((n) => (ANALYTICS_RANGES as readonly number[]).includes(n))
  .catch(30);
const granularitySchema = z.enum(['day', 'week']).catch('day');

export const load: PageServerLoad = async ({ locals, url }) => {
  const days = daysSchema.parse(url.searchParams.get('days') ?? undefined);
  const granularity = granularitySchema.parse(url.searchParams.get('g') ?? undefined);
  const userId = locals.user.id;
  // Period analytics + all-time totals + per-model earnings degrade independently (a ClickHouse hiccup on one
  // shouldn't blank the others).
  const [analytics, allTime, modelEarnings] = await Promise.all([
    getContentAnalytics({ userId, days, granularity }).catch(() => null),
    getAllTimeTotals({ userId }).catch(() => null),
    getModelEarnings({ userId, days }).catch(() => null),
  ]);
  return { analytics, allTime, modelEarnings, days, granularity };
};
