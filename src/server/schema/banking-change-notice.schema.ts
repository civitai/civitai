import * as z from 'zod';
import { noticeSendFields } from '~/server/schema/notice-send.schema';

export const bankingChangeNoticeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), ...noticeSendFields }),
  z.object({
    action: z.literal('send-test'),
    email: z.email(),
    username: z.string().min(1).default('there'),
  }),
  z.object({ action: z.literal('preview'), username: z.string().min(1).default('there') }),
  z.object({ action: z.literal('sent') }),
  z.object({ action: z.literal('unmark'), userId: z.coerce.number().int().positive() }),
]);
