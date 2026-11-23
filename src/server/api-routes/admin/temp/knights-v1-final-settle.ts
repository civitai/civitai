/**
 * Knights v1 retirement: the old in-app game's last settlement, once its nightly grant and its
 * moderator-rating hooks are gone. Deleted with the rest of the v1 code.
 *
 * POST /api/admin/temp/knights-v1-final-settle   (moderator session or `Authorization: Bearer <moderator API key>`)
 *   { "action": "status" }
 *       How many v1 votes are still Pending.
 *   { "action": "void" }
 *       Settles every Pending vote as Inconclusive, which pays nothing. When `processed.status` is not
 *       `processed`, run it again a minute later.
 *   { "action": "pay", "from": "2026-11-18" }
 *       Pays every day from `from` through today. A day the nightly grant already paid is rejected
 *       by the Buzz service as a duplicate, so an early `from` costs nothing.
 */
import * as z from 'zod';
import {
  countPendingV1Votes,
  payV1Days,
  voidPendingV1Votes,
} from '~/server/games/new-order/v1-final-settle';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('void') }),
  z.object({ action: z.literal('pay'), from: z.coerce.date() }),
]);

export default defineModeratorEndpoint('knights.v1FinalSettle', {
  method: 'POST',
  summary: 'Knights v1 retirement: void the still-Pending v1 votes and pay the last days.',
  returns: '{ pending } for status, { images, processed } for void, { days } for pay',
  rateLimit: { max: 10, windowSeconds: 60 },
  input: schema,
  async handler(input) {
    if (input.action === 'status') return { pending: await countPendingV1Votes() };
    if (input.action === 'void') return voidPendingV1Votes();
    return payV1Days(input.from);
  },
});
