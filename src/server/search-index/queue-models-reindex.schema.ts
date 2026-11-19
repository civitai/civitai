import * as z from 'zod';
import { booleanString } from '~/utils/zod-helpers';

/** The endpoints' query: `dryRun` (default true) queues nothing; `chunkSize` ids per queueUpdate call. */
export const queueModelsReindexSchema = z.object({
  dryRun: booleanString().default(true),
  chunkSize: z.coerce.number().min(1).max(10000).default(1000),
});
