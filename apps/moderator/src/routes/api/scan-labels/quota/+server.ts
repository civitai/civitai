import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { getQuotaReport } from '$lib/server/scan-label-metrics.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

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
    'status: met, missed (some votes but fewer than the quota), off (no votes that day: a day off, not a miss), unlisted (voted but not on the roster).',
    'Today is still in progress; ask for yesterday or earlier to judge a full day.',
  ],
  handler: async ({ day, days }) => {
    const to = day ?? yesterday();
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const moderators = await getQuotaReport(from, to);
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
