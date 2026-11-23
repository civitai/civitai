import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { aggregateSignals } from '~/server/services/app-assistant/submission-trace.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;
const MAX_DAYS = 366;

export default defineModeratorEndpoint('apps.assistantTrace.signals', {
  method: 'GET',
  summary:
    'App submission signals in aggregate: per week, how many submissions were traced, how many kept the default theme, and turns/Buzz per traced build; and which developer docs the builds read.',
  returns:
    '{ from, to, weeks: [{ week, submissions, withSessions, themeCustomized, themeDefault, themeUnknown, avgTurns, avgBuzz }], docsTopics: [{ topic, submissions, themeCustomized }] }',
  notes: [
    'Read-only. Counts submissions that have a trace (tracing on at submit), every submitter included.',
    `Window \`[from, to)\`: defaults to the last ${DEFAULT_DAYS} days, at most ${MAX_DAYS}. Weeks start Monday (UTC).`,
    '`avgTurns` / `avgBuzz` are over submissions with at least one traced chat. `docsTopics` (top 50) counts submissions whose chats read the page, and of those how many customised the theme.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    from: z.coerce.date().optional().describe('Inclusive. ISO-8601.'),
    to: z.coerce.date().optional().describe('Exclusive. ISO-8601; defaults to now.'),
  }),
  async handler(input) {
    const to = input.to ?? new Date();
    const from = input.from ?? new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
    if (from >= to)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '`from` must be before `to`' });
    if (to.getTime() - from.getTime() > MAX_DAYS * DAY_MS)
      throw new TRPCError({ code: 'BAD_REQUEST', message: `At most ${MAX_DAYS} days per read` });
    return aggregateSignals({ from, to });
  },
});
