import { env } from '~/env/server';
import {
  observeConsumerMismatch,
  observeConsumerUnverifiable,
} from '~/server/orchestrator/orchestrator-identity-metrics';
import { logToAxiom } from '~/server/logging/client';
import { deleteWorkflow } from '~/server/services/orchestrator/workflows';
import { throwInternalServerError } from '~/server/utils/errorHandling';

/** How long to wait for the teardown of a mis-attributed workflow before giving up on it. Sized well
 *  under the module's 20s read backstops: this runs on the submit path with the user waiting, and the
 *  throw below does not depend on the delete succeeding. */
const DELETE_TIMEOUT_MS = 5_000;

/**
 * The orchestrator names a workflow `<owning userId>-<timestamp>`, so the id it returns from a
 * submit reports which consumer it authenticated the request as. Returns null when the id carries
 * no numeric prefix — an id shape this app does not control must not be able to reject a
 * legitimate generation.
 */
export function workflowOwnerId(workflowId: string | undefined | null): number | null {
  if (!workflowId) return null;
  const prefix = workflowId.split('-')[0];
  // Rejects the forms Number() would otherwise accept — `0x10`, `1e3`, `+42` — each of which would
  // infer an owner that is not the one named in the id, i.e. fail CLOSED against the wrong user.
  if (!/^\d+$/.test(prefix)) return null;
  const parsed = Number(prefix);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Refuse a workflow the orchestrator attributed to someone other than the user who submitted it.
 * Call it on every submit path that spends a user's Buzz, immediately after the submit returns.
 *
 * This is the second half of the identity guard, and the half `getOrchestratorToken` cannot cover:
 * the token this app sends can be the right one and still be resolved to the wrong consumer inside
 * the orchestrator's own auth cache. From here the two are indistinguishable, and the consequence is
 * identical — the workflow is owned, queued and BILLED to a stranger, silently, which is what
 * happened to roughly a thousand generations over six hours on 2026-08-30.
 *
 * Deleting is bounded and best-effort, and does not gate the throw: leaving a mis-attributed
 * workflow running would keep the wrong queue polluted and the wrong account charged even though the
 * submitter has already been told it failed. It is reported separately from the throw because a
 * teardown that did not happen is the one thing this instrument must not overstate.
 *
 * Fails OPEN on an unrecognised id shape, counted so a dead guard is distinguishable from a clean
 * one. Fails open in dev, where every user shares the system token by construction.
 */
export async function assertWorkflowOwner(
  workflow: { id?: string | null } | null | undefined,
  userId: number,
  token: string
): Promise<void> {
  // `getOrchestratorToken` hands every user ORCHESTRATOR_ACCESS_TOKEN in dev, so the orchestrator
  // attributes every workflow to the system account and this guard would reject every local
  // generation.
  if (env.ORCHESTRATOR_MODE === 'dev') return;

  const ownerId = workflowOwnerId(workflow?.id);
  if (ownerId === null) {
    observeConsumerUnverifiable();
    return;
  }
  if (ownerId === userId) return;

  const workflowId = workflow?.id as string;
  let outcome: 'deleted' | 'delete-failed' = 'deleted';
  try {
    await deleteWorkflow({
      workflowId,
      token,
      // Without this a non-2xx teardown RESOLVES (the generated client defaults to
      // ThrowOnError=false and this wrapper does not inspect the reply), and the workflow would be
      // reported as torn down while it kept running and kept billing the wrong account.
      throwOnError: true,
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    });
  } catch {
    outcome = 'delete-failed';
  }
  observeConsumerMismatch(outcome);
  logToAxiom({
    name: 'orchestrator-consumer-mismatch',
    type: 'error',
    userId,
    ownerId,
    workflowId,
    outcome,
  }).catch(() => undefined);

  // An Error, not a string: throwInternalServerError reads `.message` off its argument and falls
  // back to generic copy for anything without one.
  throw throwInternalServerError(
    new Error(
      'We could not confirm who this generation belongs to, so it was cancelled. Please try again.'
    )
  );
}
