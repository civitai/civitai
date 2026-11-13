import * as z from 'zod';
import { noticeSendFields } from '~/server/schema/notice-send.schema';

const notice = z.enum(['nc-recent', 'nc-older']);
const date = z.string().min(3).max(40);
const username = z.string().min(1).max(64).default('there');
const sample = {
  // Overrides for the send-test and preview samples only.
  baseModels: z.array(z.string().min(1).max(64)).min(1).max(8).optional(),
  versions: z.array(z.string().min(1).max(200)).max(20).default([]),
};
export const ncEarningsNoticeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send'),
    notice,
    // The frozen audience, posted by the operator so no user ids live in the repo.
    userIds: z.array(z.coerce.number().int().positive()).min(1).max(1000),
    date,
    ...noticeSendFields,
  }),
  z.object({ action: z.literal('send-test'), notice, email: z.email(), date, username, ...sample }),
  z.object({ action: z.literal('preview'), notice, date, username, ...sample }),
  z.object({ action: z.literal('sent'), notice }),
  z.object({ action: z.literal('unmark'), notice, userId: z.coerce.number().int().positive() }),
]);
