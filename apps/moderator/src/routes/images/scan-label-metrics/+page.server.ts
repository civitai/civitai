import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm, userIdSchema } from '$lib/server/query';
import {
  getActionHealth,
  getDailyTotals,
  getModeratorStats,
  getQuotaReport,
  getVersionStats,
  removeFromRoster,
  setQuota,
  type RosterResult,
} from '$lib/server/scan-label-metrics.service';
import { resolveUserId } from '$lib/server/user-lookup.service';
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

const addSchema = z.object({
  user: z.string().trim().min(1, 'Enter a user id or username.').max(100),
  dailyVotes: z.coerce
    .number()
    .int()
    .min(DEFAULT_DAILY_QUOTA, `The daily quota is at least ${DEFAULT_DAILY_QUOTA}.`)
    .max(10_000),
});

const REFUSAL: Record<Extract<RosterResult, { ok: false }>['reason'], (who: string) => string> = {
  'no-user': (who) => `No user ${who}.`,
  'not-moderator': (who) =>
    `${who} is not a moderator, so they cannot open the moderator app. Make them a moderator first.`,
  'not-on-roster': (who) => `${who} is not on the roster.`,
  'no-role': () =>
    'The Scan Labels role does not exist in the auth hub yet, so nobody can be added. Ask an admin to create it.',
};

const SESSION_LAG = ' Their access may take up to 4 hours to update.';

export const actions: Actions = {
  setQuota: requiresGrant('scan-label.quota.edit', async ({ request, locals }) => {
    const input = parseForm(addSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'quota' as const, error: input });
    const userId = await resolveUserId(input.user);
    if (!userId)
      return fail(404, { scope: 'quota' as const, error: REFUSAL['no-user'](`"${input.user}"`) });
    const res = await setQuota({
      userId,
      dailyVotes: input.dailyVotes,
      active: true,
      updatedBy: locals.user.id,
    });
    const who = res.ok ? res.username ?? `#${userId}` : input.user;
    if (!res.ok) return fail(400, { scope: 'quota' as const, error: REFUSAL[res.reason](who) });
    const notice = `${who} is on the roster with ${input.dailyVotes} daily votes.`;
    return { scope: 'quota' as const, notice: res.sessionBusted ? notice : notice + SESSION_LAG };
  }),
  removeParticipant: requiresGrant('scan-label.quota.edit', async ({ request, locals }) => {
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'quota' as const, error: input });
    const res = await removeFromRoster({ userId: input.userId, updatedBy: locals.user.id });
    if (!res.ok)
      return fail(400, { scope: 'quota' as const, error: REFUSAL[res.reason](`#${input.userId}`) });
    const notice = `${res.username ?? `#${input.userId}`} is off the roster.`;
    return { scope: 'quota' as const, notice: res.sessionBusted ? notice : notice + SESSION_LAG };
  }),
};
