import { getWorkflow, submitWorkflow, type Workflow } from '@civitai/orchestration-client';
import { getModeratorDb } from '../moderator-db';
import { getOrchestratorClient, isGoneStatus } from '../orchestrator';
import type { ProbeResult } from '$lib/scan-probe';
import { resolveProbeCandidates } from './eligibility';
import {
  getOwnRun,
  recordOutcome,
  reserveRuns,
  settleSubmit,
  tripAbandonedPending,
  unresolvedRuns,
  UNRESOLVED_OUTCOME,
  type ReserveRefusal,
  type ScanProbeDb,
  type ScanProbeTables,
  type SubmitOutcome,
} from './runs';
import {
  buildProbeWorkflow,
  isSystemAccountWorkflow,
  projectScanSignals,
  readVerdict,
  tripsBreaker,
} from './workflow';

const ORCHESTRATOR_TIMEOUT_MS = 15_000;
const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'canceled']);

export const probeDb = (): ScanProbeDb =>
  getModeratorDb().withTables<ScanProbeTables>() as unknown as ScanProbeDb;

type WorkflowRead =
  | { kind: 'found'; workflow: Workflow }
  | { kind: 'gone' }
  /** Could not ask: an outage is not an answer about the workflow. */
  | { kind: 'unknown' };

async function readWorkflow(workflowId: string): Promise<WorkflowRead> {
  try {
    const { data, response } = await getWorkflow({
      client: getOrchestratorClient(),
      path: { workflowId },
      signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
    });
    if (data) return { kind: 'found', workflow: data };
    return response && isGoneStatus(response.status) ? { kind: 'gone' } : { kind: 'unknown' };
  } catch (e) {
    console.error('[scan-probe] workflow read failed', { workflowId, error: e });
    return { kind: 'unknown' };
  }
}

/** Records the verdict of a finished workflow, tripping the breaker if it calls for it. */
async function settleOutcome(db: ScanProbeDb, runId: string, workflow: Workflow) {
  const workflowStatus = String(workflow.status ?? 'unknown');
  if (!TERMINAL.has(workflowStatus)) return { workflowStatus, terminal: false } as const;
  const verdict = readVerdict(workflow.steps);
  await recordOutcome(db, runId, {
    workflowStatus,
    verdict,
    tripped: tripsBreaker(workflowStatus, verdict),
  });
  return { workflowStatus, terminal: true } as const;
}

const tripUnresolved = (db: ScanProbeDb, runId: string, workflowStatus: string) =>
  recordOutcome(db, runId, { workflowStatus, verdict: null, tripped: true });

/**
 * Brings every unresolved run's verdict in before a new batch is allowed, so the breaker never
 * depends on someone having polled the page. A run whose verdict cannot be had trips it; one the
 * orchestrator could not be asked about stays in flight and holds the next batch.
 */
async function reconcile(db: ScanProbeDb): Promise<void> {
  await tripAbandonedPending(db);
  for (const run of await unresolvedRuns(db)) {
    if (!run.workflow_id) continue;
    const read = await readWorkflow(run.workflow_id);
    if (read.kind === 'found') await settleOutcome(db, run.id, read.workflow);
    else if (read.kind === 'gone') await tripUnresolved(db, run.id, UNRESOLVED_OUTCOME.gone);
  }
}

export type RunProbeResult =
  | { ok: true; submitted: number; failed: number; refused: number[] }
  | {
      ok: false;
      reason: 'nothing-eligible' | ReserveRefusal | typeof UNRESOLVED_OUTCOME.wrongAccount;
      refused: number[];
    };

/**
 * Settles earlier runs, refuses what may not be scanned, records a `pending` row per remaining
 * image, and only then submits. A failed record throws before anything reaches the orchestrator.
 */
export async function runProbe(moderatorId: number, imageIds: number[]): Promise<RunProbeResult> {
  const db = probeDb();
  await reconcile(db);
  // After reconcile, which can take a while: eligibility is read as close to the submit as it can be.
  const { eligible, refused } = await resolveProbeCandidates(imageIds);
  if (!eligible.length) return { ok: false, reason: 'nothing-eligible', refused };

  const reserved = await reserveRuns(
    db,
    moderatorId,
    eligible.map((c) => c.imageId)
  );
  if (!reserved.ok) return { ok: false, reason: reserved.reason, refused };

  const urlByImage = new Map(eligible.map((c) => [c.imageId, c.mediaUrl]));
  let submitted = 0;
  let failed = 0;
  let stopped = false;
  let wrongAccount = false;
  for (const run of reserved.runs) {
    const mediaUrl = urlByImage.get(run.imageId);
    let outcome: SubmitOutcome = { skipped: true };
    if (mediaUrl && !stopped) {
      outcome = { unknown: true };
      try {
        const { data } = await submitWorkflow({
          client: getOrchestratorClient(),
          body: buildProbeWorkflow(mediaUrl),
          signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
        });
        if (data?.id) outcome = { workflowId: data.id };
      } catch (e) {
        console.error('[scan-probe] submit failed', { runId: run.id, error: e });
      }
    }
    if (!(await settleSubmit(db, run.id, outcome)))
      console.error('[scan-probe] run row did not settle', { runId: run.id, outcome });
    if (!('workflowId' in outcome)) {
      failed++;
      if ('unknown' in outcome) stopped = true;
      continue;
    }
    submitted++;
    if (!isSystemAccountWorkflow(outcome.workflowId)) {
      console.error('[scan-probe] workflow is not the system account', { runId: run.id, outcome });
      await tripUnresolved(db, run.id, UNRESOLVED_OUTCOME.wrongAccount);
      stopped = wrongAccount = true;
    }
  }
  if (wrongAccount) return { ok: false, reason: UNRESOLVED_OUTCOME.wrongAccount, refused };
  return { ok: true, submitted, failed, refused };
}

/** The signals for one of `moderatorId`'s runs. Reads by the run row, never a caller's workflow id. */
export async function readProbe(runId: string, moderatorId: number): Promise<ProbeResult | null> {
  const db = probeDb();
  const run = await getOwnRun(db, runId, moderatorId);
  if (!run) return null;
  if (run.status === 'pending') return { state: 'pending' };
  if (run.status !== 'submitted' || !run.workflow_id) return { state: 'submit-failed' };
  if (run.workflow_status === UNRESOLVED_OUTCOME.wrongAccount) return { state: 'unavailable' };

  const read = await readWorkflow(run.workflow_id);
  if (read.kind !== 'found') {
    if (read.kind === 'gone' && !run.workflow_status)
      await tripUnresolved(db, run.id, UNRESOLVED_OUTCOME.gone);
    if (run.workflow_status)
      return { state: 'done', workflowStatus: run.workflow_status, signals: null };
    return read.kind === 'gone'
      ? { state: 'unavailable' }
      : { state: 'running', workflowStatus: 'unknown' };
  }
  const { workflowStatus, terminal } = run.workflow_status
    ? { workflowStatus: run.workflow_status, terminal: true }
    : await settleOutcome(db, run.id, read.workflow);
  if (!terminal) return { state: 'running', workflowStatus };
  return { state: 'done', workflowStatus, signals: projectScanSignals(read.workflow.steps) };
}
