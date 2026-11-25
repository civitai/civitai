/**
 * How long a host waits for an App Block to acknowledge `BLOCK_READY` before it treats the launch
 * as timed out. ONE window, shared by every host and the review boot-check gate: a separate value
 * would let the gate pass an app the hosts time out on.
 */
export const BLOCK_READY_TIMEOUT_MS = 10_000;
