import type { PageServerLoad } from './$types';
import {
  getPendingWorkflowGates,
  getTrainingReviewQueue,
} from '$lib/server/training-moderation.service';

export const load: PageServerLoad = async () => {
  const queue = await getTrainingReviewQueue();
  return {
    ...queue,
    // Streamed, not awaited: it reads the ledger and every candidate from the orchestrator, and the
    // version queue above it should not wait on that.
    workflowGates: getPendingWorkflowGates(),
  };
};
