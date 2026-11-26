import { TRPCError } from '@trpc/server';
import type { CustomComfyStep, Workflow } from '@civitai/orchestration-client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { env } from '~/env/server';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { RUNNER_TOKEN_LIFETIME_SECONDS } from '~/server/services/block-token.service';
import { settleReservedLegs } from '~/server/services/blocks/custom-comfy-settle.service';
import {
  listRunnerAttempts,
  touchRunnerAttempt,
  transitionRunnerAttempt,
  type RunnerAttemptRow,
  type RunnerAttemptState,
} from '~/server/services/blocks/runner-ledger.service';
import { appBlockTag, orchestratorBlockStatus } from '~/server/services/blocks/workflow.service';
import { isWorkflowOwnedBy } from '~/server/services/orchestrator/assert-workflow-owner';
import { cancelWorkflow, getWorkflow } from '~/server/services/orchestrator/workflows';

// The recipe runner's ledger jobs. Runner tokens cannot poll, and a runner submit writes no settle
// record, so these are the only paths that settle or release a runner attempt.

/** A submit that has not reached the orchestrator within this long never will. */
const SUBMIT_DEADLINE_SECONDS = 10 * 60;
export const RUNNER_ATTEMPT_STALE_MS =
  (RUNNER_TOKEN_LIFETIME_SECONDS + SUBMIT_DEADLINE_SECONDS) * 1000;
export const RUNNER_UNKNOWN_ALARM_MS = 60 * 60 * 1000;
const BATCH = 200;
const CANCEL_MARKER_TTL_SECONDS = 60 * 60;
/** A held row is GET again after this: each GET wakes the workflow's grain and its recovery paths. */
const HELD_BACKOFF_SECONDS = 15 * 60;

export interface RunnerReconcileDeps {
  /** The workflow, or null when the orchestrator has none by that id. */
  getWorkflow(workflowId: string): Promise<Workflow | null>;
  /** The HTTP status of the cancel; throws (with `status`) on a non-2xx. */
  cancelWorkflow(workflowId: string): Promise<number | undefined>;
  /** The `block_workflows` read model. */
  markWorkflowStatus(workflowId: string, status: string): Promise<unknown>;
  reverseAuthorFee(workflowId: string, terminalStatus: string): Promise<unknown>;
}

function systemToken(): string {
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) throw new Error('ORCHESTRATOR_ACCESS_TOKEN is not configured');
  return token;
}

const liveDeps: RunnerReconcileDeps = {
  getWorkflow: async (workflowId) => {
    try {
      return await getWorkflow({ token: systemToken(), path: { workflowId } });
    } catch (error) {
      if (error instanceof TRPCError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  },
  cancelWorkflow: (workflowId) =>
    cancelWorkflow({ workflowId, token: systemToken(), throwOnError: true }),
  markWorkflowStatus: async (workflowId, status) => {
    const { updateBlockWorkflowStatus } = await import(
      '~/server/services/blocks/block-workflows.service'
    );
    return updateBlockWorkflowStatus({ workflowId, status: status as never });
  },
  reverseAuthorFee: async (workflowId, terminalStatus) => {
    const { reverseBlockAuthorFee } = await import(
      '~/server/services/blocks/author-fee-charge.service'
    );
    return reverseBlockAuthorFee({ workflowId, terminalStatus });
  },
};

function alarm(name: string, payload: Record<string, unknown>, error?: unknown) {
  logToAxiom({
    name,
    type: 'error',
    payload,
    error: error === undefined ? undefined : safeError(error),
  });
}

type ReconcileOutcome = 'settled' | 'running' | 'held' | 'lost';

/**
 * Settle each `submitted` attempt whose workflow is terminal, from the attempt row. The ledger move
 * out of `submitted` is the gate: only the writer that makes it moves the Redis legs, so two
 * reconciler runs on one attempt settle it once.
 */
export async function reconcileRunnerAttempts(
  db: Kysely<DB>,
  deps: RunnerReconcileDeps = liveDeps,
  now = new Date()
) {
  const rows = await listRunnerAttempts(db, {
    state: 'submitted',
    updatedBefore: now,
    limit: BATCH,
  });
  const counts: Record<ReconcileOutcome | 'errors', number> = {
    settled: 0,
    running: 0,
    held: 0,
    lost: 0,
    errors: 0,
  };
  for (const row of rows) {
    try {
      counts[await reconcileAttempt(db, deps, row)]++;
    } catch (error) {
      counts.errors++;
      alarm('runner-reconcile-error', { attemptId: row.attemptId }, error);
    }
  }
  return counts;
}

async function reconcileAttempt(
  db: Kysely<DB>,
  deps: RunnerReconcileDeps,
  row: RunnerAttemptRow
): Promise<ReconcileOutcome> {
  const held = async (reason: string) => {
    alarm('runner-reconcile-held', {
      attemptId: row.attemptId,
      workflowId: row.workflowId,
      reason,
    });
    // Out of the next passes, so held rows cannot fill every batch or poll the orchestrator hot.
    await touchRunnerAttempt(db, row.attemptId, 'submitted', HELD_BACKOFF_SECONDS);
    return 'held' as const;
  };
  if (!row.workflowId) return await held('no_workflow_id');
  const workflow = await deps.getWorkflow(row.workflowId);
  if (!workflow) return await held('workflow_not_found');
  // Every dev user shares the system token, so ids carry its owner (as `assertWorkflowOwner`).
  if (env.ORCHESTRATOR_MODE !== 'dev' && !isWorkflowOwnedBy(workflow.id, row.userId)) {
    return await held('owner_mismatch');
  }
  if (!row.appId || !(workflow.tags ?? []).includes(appBlockTag(row.appId))) {
    return await held('app_tag_mismatch');
  }

  const status = orchestratorBlockStatus(workflow);
  const cost = workflow.cost?.total;
  const actual = Math.ceil(typeof cost === 'number' && cost > 0 ? cost : 0);
  if (
    status !== 'succeeded' &&
    status !== 'failed' &&
    status !== 'expired' &&
    status !== 'canceled'
  ) {
    const observed = Math.max(actual, liveCustomComfyCost(workflow));
    if (observed > row.reservedAmount) await cancelOverCeiling(deps, row, observed);
    return 'running';
  }

  const to: RunnerAttemptState =
    status === 'succeeded' ? 'settled' : actual === 0 ? 'refunded' : 'failed';
  // Idempotent, so before the gate: a crash after it would otherwise lose them for good.
  await deps
    .markWorkflowStatus(row.workflowId, status)
    .catch((error) => alarm('runner-reconcile-read-model', { attemptId: row.attemptId }, error));
  if (status !== 'succeeded') await deps.reverseAuthorFee(row.workflowId, status);

  const moved = await transitionRunnerAttempt(db, row.attemptId, 'submitted', to, {
    chargedAmount: actual,
  });
  if (!moved) return 'lost';

  if (row.reservation) {
    // Overage is charged too: the ledger and every cap counter adopt the actual charge.
    await settleReservedLegs(row.reservation, row.reservation.amount, actual, true);
  } else {
    alarm('runner-reconcile-no-reservation', { attemptId: row.attemptId });
  }
  if (actual > row.reservedAmount) {
    alarm('runner-charge-drift', {
      attemptId: row.attemptId,
      runId: row.runId,
      ceiling: row.reservedAmount,
      charged: actual,
    });
  }

  logToAxiom({
    name: 'runner-attempt-settled',
    type: 'info',
    payload: { attemptId: row.attemptId, runId: row.runId, state: to, charged: actual },
  });
  return 'settled';
}

/**
 * The backstop for a per-run bound the orchestrator does not enforce: cancel a workflow whose cost
 * passed the attempt's reserved ceiling. Cancels only; the settle adopts whatever it charged. Once
 * per attempt (a marker), released when the cancel fails so the next run retries it.
 */
async function cancelOverCeiling(
  deps: RunnerReconcileDeps,
  row: RunnerAttemptRow,
  observedCost: number
) {
  const key = `${REDIS_KEYS.BLOCKS.RUNNER_OVER_CEILING_CANCEL}:${row.attemptId}` as const;
  if ((await redis.set(key, '1', { NX: true, EX: CANCEL_MARKER_TTL_SECONDS })) === null) return;
  const payload = {
    attemptId: row.attemptId,
    runId: row.runId,
    workflowId: row.workflowId,
    ceiling: row.reservedAmount,
    observedCost,
    reason: 'over_reserved_ceiling',
  };
  try {
    const status = await deps.cancelWorkflow(row.workflowId!);
    alarm('runner-attempt-over-ceiling', { ...payload, outcome: 'canceled', status });
  } catch (error) {
    await redis.del(key);
    const status = (error as { status?: number }).status ?? null;
    alarm('runner-attempt-over-ceiling', { ...payload, outcome: 'cancel_failed', status }, error);
  }
}

/**
 * What a running customComfy workflow has accrued. `cost.total` prices finished attempts only, so
 * mid-run it reads 0; each step's `usage.estimatedCost` covers the current attempt too, as fresh as
 * the worker's last runtime report. Runner tips are 0.
 */
function liveCustomComfyCost(workflow: Workflow): number {
  let total = 0;
  for (const step of workflow.steps ?? []) {
    if (step.$type !== 'customComfy') continue;
    const estimated = (step as CustomComfyStep).output?.usage?.estimatedCost;
    if (typeof estimated === 'number' && estimated > 0) total += Math.ceil(estimated);
  }
  return total;
}

/**
 * Release attempts a submit stalled on. `reserved` (never sent) -> `refunded`. `submitting` (may
 * have been sent) -> `unknown`, never refunded. Alarms on every `unknown` older than an hour,
 * which is resolved by hand.
 */
export async function sweepRunnerAttempts(db: Kysely<DB>, now = new Date()) {
  const stale = new Date(now.getTime() - RUNNER_ATTEMPT_STALE_MS);
  let refunded = 0;
  let unknown = 0;
  // A `reserved` attempt names no Redis legs (the `submitting` move writes them). A leg its
  // crashed submit already took stays counted until its key expires: the stricter cap.
  for (const row of await listRunnerAttempts(db, {
    state: 'reserved',
    updatedBefore: stale,
    limit: BATCH,
  })) {
    if (await transitionRunnerAttempt(db, row.attemptId, 'reserved', 'refunded')) refunded++;
  }
  for (const row of await listRunnerAttempts(db, {
    state: 'submitting',
    updatedBefore: stale,
    limit: BATCH,
  })) {
    if (await transitionRunnerAttempt(db, row.attemptId, 'submitting', 'unknown')) {
      unknown++;
      alarm('runner-attempt-unknown', { attemptId: row.attemptId, reason: 'stalled_submit' });
    }
  }
  const held = await listRunnerAttempts(db, {
    state: 'unknown',
    updatedBefore: new Date(now.getTime() - RUNNER_UNKNOWN_ALARM_MS),
    limit: BATCH,
  });
  if (held.length > 0) {
    alarm('runner-attempt-unknown-stale', { attemptIds: held.map((r) => r.attemptId) });
  }
  return { refunded, unknown, unknownStale: held.length };
}
