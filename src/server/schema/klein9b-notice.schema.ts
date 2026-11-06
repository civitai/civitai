import * as z from 'zod';
import { noticeSendFields } from '~/server/schema/notice-send.schema';

const variant = z.enum(['charged', 'uncharged']);
const date = z.string().min(3).max(40);
export const klein9bNoticeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send'),
    date,
    ...noticeSendFields,
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
