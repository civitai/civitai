/**
 * Binds a userId to a cached orchestrator token so the association can be re-checked
 * where the token is USED, not merely assumed to have survived where it was stored.
 *
 * A generation token is an opaque bearer with nothing in it naming its owner, and the
 * orchestrator derives the whole identity of a submit from it — who owns the workflow,
 * whose queue it joins, whose Buzz pays. So any layer that hands back the wrong one
 * (the owned-token sysRedis hash, the per-pod LRU, or the transport under either)
 * silently bills a stranger, and nothing anywhere notices. That is not hypothetical:
 * over six hours on 2026-08-30 roughly a thousand generations were charged to accounts
 * that did not make them. The proof was a workflow owned by one user whose signal
 * callback URL — written by this app from `ctx.user.id` on the same request — named a
 * different one.
 *
 * Storing the id alongside the token and re-reading it at the point of use converts
 * every such mis-association into a cache miss and a fresh, correct mint, whatever
 * caused it. It cannot fix a mis-resolution INSIDE the orchestrator's own auth cache;
 * `assertWorkflowOwner` at the submit site is the guard for that half.
 */

const SEPARATOR = '.';

/** Encoded form written to both cache layers. `generateKey` is hex, so `.` cannot collide. */
export function encodeOwnedToken(userId: number, token: string): string {
  return `${userId}${SEPARATOR}${token}`;
}

export type OwnedTokenOutcome =
  /** Value is present and owned by the expected user. */
  | 'ok'
  /** No cached value. */
  | 'absent'
  /**
   * A value with no owner prefix. Reachable only from a writer that has not been taught
   * to encode; kept distinct from `mismatch` so such a writer degrades to an ordinary
   * miss instead of firing the cross-user alarm on every read.
   */
  | 'unowned'
  /** Encoded, and encoded for someone else. This is the one that must never be used. */
  | 'mismatch';

export function decodeOwnedToken(
  value: string | null | undefined,
  userId: number
): { token: string | null; outcome: OwnedTokenOutcome; ownerId?: string } {
  if (!value) return { token: null, outcome: 'absent' };

  const i = value.indexOf(SEPARATOR);
  if (i < 0) return { token: null, outcome: 'unowned' };

  const ownerId = value.slice(0, i);
  // A prefix that is not a userId at all is an untaught writer, not a cross-user fault. Without
  // this, any dotted value would report `mismatch` and page on a series whose whole meaning is
  // "someone is being billed for someone else's generation".
  if (!/^\d+$/.test(ownerId)) return { token: null, outcome: 'unowned' };
  if (ownerId !== String(userId)) return { token: null, outcome: 'mismatch', ownerId };

  return { token: value.slice(i + 1), outcome: 'ok' };
}
