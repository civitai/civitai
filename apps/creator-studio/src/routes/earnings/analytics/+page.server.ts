import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getContentAnalytics, ANALYTICS_RANGES } from '$lib/server/analytics';

const daysSchema = z.coerce
  .number()
  .int()
  .refine((n) => (ANALYTICS_RANGES as readonly number[]).includes(n))
  .catch(30);

export const load: PageServerLoad = async ({ locals, url }) => {
  const days = daysSchema.parse(url.searchParams.get('days') ?? undefined);
  try {
    const analytics = await getContentAnalytics(locals.user.id, days);
    return { analytics, days };
  } catch {
    // ClickHouse unreachable/misconfigured — degrade gracefully rather than 500 the page.
    return { analytics: null, days };
  }
};
