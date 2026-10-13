import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { getQuotaReport } from '$lib/server/scan-label-metrics.service';
import { DAY_MS, dayRange, isoDay } from '$lib/scan-labels';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const GET = defineWebhookEndpoint({
  summary: 'Scan label votes per moderator per UTC day, against each moderator’s daily quota.',
  input: z.object({
    day: z
      .string()
      .regex(DAY)
      .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a calendar day.')
      .optional()
      .describe('Last UTC day of the report, YYYY-MM-DD. Defaults to yesterday.'),
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(31)
      .default(1)
      .describe('How many days, ending at `day`.'),
  }),
  returns:
    '{ from, to, moderators: [{ userId, username, quota, onRoster, days: [{ day, votes, status }] }], missed: [{ userId, username, day, votes, quota }] }',
  notes: [
    'status: met, missed (some votes but fewer than the quota), off (no votes that day: a day off, not a miss), in-progress (today, quota not yet met), unlisted (voted but not on the roster).',
    'Every day is judged against the CURRENT quota and roster, not the ones in force that day.',
  ],
  handler: async ({ day, days }) => {
    const to = day ?? isoDay(new Date(Date.now() - DAY_MS));
    const moderators = await getQuotaReport(to, days);
    const from = dayRange(to, days)[0];
    const missed = moderators.flatMap((m) =>
      m.days
        .filter((d) => d.status === 'missed')
        .map((d) => ({
          userId: m.userId,
          username: m.username,
          day: d.day,
          votes: d.votes,
          quota: m.quota,
        }))
    );
    return { from, to, moderators, missed };
  },
});
