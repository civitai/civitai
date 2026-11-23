/**
 * Knights v1 retirement: the old in-app game's last settlement, once its nightly grant and its
 * moderator-rating hooks are gone. Deleted with the rest of the v1 code.
 *
 * Run after both the main app and the moderator app have finished rolling out, in this order.
 *
 * POST /api/admin/temp/knights-v1-final-settle   (moderator session or `Authorization: Bearer <moderator API key>`)
 *   { "action": "status" }
 *       v1 votes still Pending, and payout-blocked players whose held v1 Buzz nothing pays any more.
 *   { "action": "void" }
 *       Settles every Pending vote as Inconclusive, which pays nothing. With `retry: true`, run it
 *       again a minute later. Done when `status` reports no Pending votes.
 *   { "action": "pay", "from": "2026-11-21" }
 *       Pays every day from `from` through today. Use the first day the nightly grant had not paid:
 *       an already-paid day is rejected as a duplicate, but a player unbanned since would be paid it.
 */
import * as z from 'zod';
import {
  countHeldV1Players,
  countPendingV1Votes,
  payV1Days,
  voidPendingV1Votes,
} from '~/server/games/new-order/v1-final-settle';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import dayjs from '~/shared/utils/dayjs';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('void') }),
  z.object({
    action: z.literal('pay'),
    from: z.coerce
      .date()
      .refine((d) => dayjs().diff(d, 'day') <= 14, 'from must be within the last 14 days'),
  }),
]);

export default defineModeratorEndpoint('knights.v1FinalSettle', {
  method: 'POST',
  summary: 'Knights v1 retirement: void the still-Pending v1 votes and pay the last days.',
  returns: '{ pending, held } for status, { images, processed, retry } for void, { days } for pay',
  rateLimit: { max: 10, windowSeconds: 60 },
  input: schema,
  async handler(input) {
    if (input.action === 'status') {
      const [pending, held] = await Promise.all([countPendingV1Votes(), countHeldV1Players()]);
      return { pending, held };
    }
    if (input.action === 'void') return voidPendingV1Votes();
    return payV1Days(input.from);
  },
});
