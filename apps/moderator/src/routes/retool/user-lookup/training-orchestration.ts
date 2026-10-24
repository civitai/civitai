import type {
  OrchestratorRun as OrchestratorRunRow,
  TrainingOrchestration as TrainingOrchestrationPayload,
} from '$lib/server/training-orchestration.service';

// The `/api/user-training-orchestration` payload. Derived from the service's shapes rather than
// hand-copied, per the note in `user-account.ts`. No `Jsonified` wrapper: nothing here is a `Date` —
// timestamps cross as strings the server has already zone-marked.

export type OrchestratorRun = OrchestratorRunRow;
export type TrainingOrchestration = TrainingOrchestrationPayload;

/**
 * @param withStatus also reads `orchestration.workflowSteps`; see the service.
 * @param since oldest charge on screen, `YYYY-MM-DD HH:MM:SS`. Cost scales with the width of the
 * window, not with rows returned, so pass the oldest row actually displayed.
 */
export async function fetchTrainingOrchestration(
  userId: number,
  withStatus = false,
  since: string | null = null
): Promise<TrainingOrchestration> {
  const query = new URLSearchParams();
  if (withStatus) query.set('status', '1');
  if (since) query.set('since', since);
  const r = await fetch(`/api/user-training-orchestration/${userId}?${query}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
