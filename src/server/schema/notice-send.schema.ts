import * as z from 'zod';

/** The `send` action's options, shared by every bulk notice route. */
export const noticeSendFields = {
  dryRun: z.boolean().default(true),
  // Sends are paced, so a call's run time grows with `count`: kept short enough to answer within
  // one HTTP request rather than time out and lose the summary.
  count: z.coerce.number().int().min(1).max(100).default(50),
  batchSize: z.coerce.number().int().min(1).max(5).default(1),
};
