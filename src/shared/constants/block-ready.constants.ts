/**
 * How long a host waits for an App Block to acknowledge `BLOCK_READY` before it treats the launch
 * as timed out.
 *
 * ONE value for every place that waits on it: the slot host (`IframeHost`), the page host
 * (`pageBlockHostLogic`, re-exported from there for its existing importers) and the review boot
 * check, which refuses a submitted build that does not reach `BLOCK_READY` within the same window
 * a real viewer's host would give it. A separate literal in any of them would let the review
 * gate pass an app that every real host times out on.
 *
 * Kept in `~/shared` (no React, no server imports) so both the client hosts and the server can
 * import it.
 */
export const BLOCK_READY_TIMEOUT_MS = 10_000;
