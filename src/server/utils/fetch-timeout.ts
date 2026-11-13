import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';

/**
 * Anti-hang deadlines for server-side outbound HTTP. ON by default.
 *
 * Without a signal, a `fetch` to a dependency that accepts the connection and never answers waits
 * for the platform's own header timeout (minutes), holding the request that made it. These budgets
 * are ceilings, not latency targets: generous enough that a slow but healthy call is never cut off.
 *
 * The only switch is an OFF switch: the deadline is dropped when `outbound-fetch-timeouts-off`
 * reads explicitly `true`. An uninitialised flag client or an absent flag both read `null`, which
 * keeps the deadline, so the protection never depends on flag state existing.
 */
export function fetchTimeoutsDisabled(): boolean {
  // A flag read that fails for any reason keeps the deadline: it must never remove the
  // protection, and never throw out of the fetch path it guards.
  try {
    return isFliptSync(FLIPT_FEATURE_FLAGS.OUTBOUND_FETCH_TIMEOUTS_OFF) === true;
  } catch {
    return false;
  }
}

/** `AbortSignal.timeout(ms)`, unless the off-switch is thrown. */
export function fetchTimeoutSignal(ms: number): AbortSignal | undefined {
  if (fetchTimeoutsDisabled()) return undefined;
  return AbortSignal.timeout(ms);
}

/**
 * A signal that aborts on the caller's own `signal` OR after `ms`, whichever comes first. Returns
 * the caller's signal unchanged when the off-switch is thrown.
 */
export function withFetchTimeout(ms: number, signal?: AbortSignal | null): AbortSignal | undefined {
  const timeout = fetchTimeoutSignal(ms);
  if (!timeout) return signal ?? undefined;
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type OutboundFetchInit = RequestInit & {
  /** Deadline for the whole exchange, headers AND body, in milliseconds. */
  timeoutMs: number;
};

/**
 * `fetch` with a mandatory deadline. Use it for any server-side call to another service.
 *
 * The deadline covers reading the body too (`res.json()`, `res.arrayBuffer()`), so size it for the
 * whole download. On expiry the call rejects with a `TimeoutError` DOMException, which callers
 * handle like any other network failure.
 */
export function outboundFetch(input: string | URL | Request, init: OutboundFetchInit) {
  const { timeoutMs, ...rest } = init;
  return fetch(input, { ...rest, signal: withFetchTimeout(timeoutMs, rest.signal) });
}
