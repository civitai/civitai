import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { checkboxField, parseForm } from '$lib/server/query';
import {
  getActionHealth,
  getDailyTotals,
  getModeratorStats,
  getQuotaReport,
  getVersionStats,
  setQuota,
} from '$lib/server/scan-label-metrics.service';
import { DEFAULT_DAILY_QUOTA, isoDay } from '$lib/scan-labels';

const WINDOW_DAYS = 14;

export const load: PageServerLoad = async () => {
  const now = new Date();
  const [quota, totals, versions, moderators, actions] = await Promise.all([
    getQuotaReport(isoDay(now), WINDOW_DAYS, now),
    getDailyTotals(WINDOW_DAYS, now),
    getVersionStats(),
    getModeratorStats(WINDOW_DAYS, now),
    getActionHealth(),
  ]);
  return { quota, totals, versions, moderators, actions, windowDays: WINDOW_DAYS };
};

const quotaSchema = z.object({
  userId: z.coerce.number().int().positive().max(2_147_483_647),
  dailyVotes: z.coerce
    .number()
    .int()
    .min(DEFAULT_DAILY_QUOTA, `The daily quota is at least ${DEFAULT_DAILY_QUOTA}.`)
    .max(10_000),
  active: checkboxField,
});

export const actions: Actions = {
  setQuota: requiresGrant('scan-label.quota.edit', async ({ request, locals }) => {
    const input = parseForm(quotaSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'quota' as const, error: input });
    const saved = await setQuota({ ...input, updatedBy: locals.user.id });
    if (!saved)
      return fail(404, { scope: 'quota' as const, error: `No user with id ${input.userId}.` });
    return { scope: 'quota' as const, saved: input.userId };
  }),
};
