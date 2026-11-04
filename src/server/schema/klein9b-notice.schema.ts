import * as z from 'zod';

const variant = z.enum(['charged', 'uncharged']);
const date = z.string().min(3).max(40);
export const klein9bNoticeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send'),
    date,
    dryRun: z.boolean().default(true),
    count: z.coerce.number().int().min(1).max(1000).default(50),
    // SES's sending rate is account-wide: parallel batches got throttled and refused other site emails.
    batchSize: z.coerce.number().int().min(1).max(5).default(1),
  }),
  z.object({
    action: z.literal('send-test'),
    email: z.email(),
    variant,
    date,
    username: z.string().min(1).max(64).default('there'),
  }),
  z.object({
    action: z.literal('preview'),
    variant,
    date,
    username: z.string().min(1).max(64).default('there'),
  }),
  z.object({ action: z.literal('sent') }),
  z.object({ action: z.literal('unmark'), userId: z.coerce.number().int().positive() }),
]);
