import { createHash } from 'node:crypto';

/**
 * A run's id, derived from who started it and the start's idempotency key: a retried start lands on
 * the same DBOS workflow (whose id is the run id), and one viewer's key can never name another's run.
 */
export function runIdFor(userId: string, idempotencyKey: string): string {
  return `run_${createHash('sha256')
    .update(JSON.stringify([userId, idempotencyKey]))
    .digest('hex')
    .slice(0, 32)}`;
}

/** The marker a stop by key leaves for a start that has not arrived yet. */
export function stopMarkerFor(runId: string): string {
  return `${runId}.stop`;
}
