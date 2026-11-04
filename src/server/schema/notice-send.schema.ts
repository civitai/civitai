import * as z from 'zod';

/** The `send` action's options, shared by every bulk notice route. */
export const noticeSendFields = {
  dryRun: z.boolean().default(true),
  count: z.coerce.number().int().min(1).max(1000).default(50),
  batchSize: z.coerce.number().int().min(1).max(5).default(1),
};
