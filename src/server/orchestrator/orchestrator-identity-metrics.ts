import { registerCounter, registerCounterWithLabels } from '~/server/prom/client';

/**
 * Both series should sit at flat zero. A nonzero rate on either is a live cross-user
 * identity fault on the generation path and is worth paging on, not dashboarding —
 * the failure it names charges one user's Buzz for another user's generation and
 * puts that generation in their queue.
 */

const tokenIdentityMismatchCounter = registerCounterWithLabels({
  name: 'orchestrator_token_identity_mismatch_total',
  help:
    'Count of cached orchestrator generation tokens that came back bound to a DIFFERENT userId than ' +
    'the one they were fetched for, by cache layer (redis = the generation:tokens sysRedis hash, ' +
    'lru = the per-pod cold-mint cache). Each increment is one mis-association CAUGHT and refused: ' +
    'the read is discarded and a fresh token is minted, so the request itself is served correctly. ' +
    'The label separates a shared-store fault from a per-pod one, which is the first question to ask ' +
    'and the one the 2026-08-30 incident had no way to answer. Expected value is zero.',
  labelNames: ['layer'] as const,
});

const consumerMismatchCounter = registerCounterWithLabels({
  name: 'orchestrator_consumer_mismatch_total',
  help:
    'Count of submitted workflows the orchestrator attributed to a DIFFERENT user than the session ' +
    'that submitted them, by what became of the workflow (deleted | delete-failed). Complements ' +
    'orchestrator_token_identity_mismatch_total: that one catches a token this app misplaced, this ' +
    'one catches an identity the ORCHESTRATOR resolved wrongly from a token that was correct when ' +
    'sent — the half no in-app cache check can see. Nonzero here with zero there means the fault is ' +
    'downstream of this repo. Expected value is zero.',
  labelNames: ['outcome'] as const,
});

const consumerUnverifiableCounter = registerCounter({
  name: 'orchestrator_consumer_unverifiable_total',
  help:
    'Count of submitted workflows whose id carried no numeric owner prefix, so assertWorkflowOwner ' +
    'could not check who the orchestrator attributed them to and let them through. The ' +
    '`<userId>-<timestamp>` id convention belongs to the orchestrator and is asserted nowhere else ' +
    'in this repo, so a change to it turns that guard into a permanent no-op. Without this series a ' +
    'dead guard and a clean system are the same flat zero on ' +
    'orchestrator_consumer_mismatch_total — which is the blindness the 2026-08-30 incident had. A ' +
    'sustained nonzero rate here means the guard is off, not that nothing is wrong.',
});

/** Total — a metrics hiccup must never fail the generation request that reported it. */
export function observeConsumerUnverifiable(): void {
  try {
    consumerUnverifiableCounter.inc();
  } catch {
    /* metrics are best-effort on the generation hot path */
  }
}

/** Total — a metrics hiccup must never fail the generation request that reported it. */
export function observeTokenIdentityMismatch(layer: 'redis' | 'lru'): void {
  try {
    tokenIdentityMismatchCounter.inc({ layer });
  } catch {
    /* metrics are best-effort on the generation hot path */
  }
}

/** Total — see above. */
export function observeConsumerMismatch(outcome: 'deleted' | 'delete-failed'): void {
  try {
    consumerMismatchCounter.inc({ outcome });
  } catch {
    /* metrics are best-effort on the generation hot path */
  }
}
