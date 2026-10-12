import { BLOCK_POLL_WAIT_SECONDS_WIRE_MAX } from '~/shared/constants/block-poll-wait.constants';

/**
 * A block's `POLL_WORKFLOW.waitSeconds`, made safe to forward to `blocks.pollWorkflow`, or
 * `undefined` when there is no hold to ask for.
 *
 * The procedure's input schema REJECTS a fraction, a negative or an over-large value, and both hosts
 * turn a rejected poll into a `failed` snapshot, which ends the block's watch loop on a generation
 * that is still running. So anything the schema would refuse is floored, capped or dropped here.
 * How long the hold really is stays the server's decision.
 */
export function pollWaitSecondsForWire(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  if (floored <= 0) return undefined;
  return Math.min(floored, BLOCK_POLL_WAIT_SECONDS_WIRE_MAX);
}
