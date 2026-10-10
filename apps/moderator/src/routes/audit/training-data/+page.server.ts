import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import {
  getPausedTrainingVersions,
  getPendingWorkflowGates,
} from '$lib/server/training-moderation.service';

const PAGE_SIZE = 20;

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { cursor } = parseQuery(url, querySchema);
  const versions = await getPausedTrainingVersions({ limit: PAGE_SIZE, cursor });
  return {
    ...versions,
    // Streamed, not awaited: it reads every candidate from the orchestrator, and the version queue
    // above it should not wait on that. Only on the first page — the cursor pages the version queue.
    workflowGates: cursor == null ? getPendingWorkflowGates() : null,
  };
};
