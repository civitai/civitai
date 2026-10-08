import type { IRetryPolicy, RetryContext } from '@microsoft/signalr';

// Every logged-in tab holds a signals connection, so when the hub goes down they all lose it in the
// same instant. A retry schedule that is fixed, or the same for every client, keeps them in lockstep
// for the whole outage: a hub that hung for ~45 min once drew hub connects up ~200x and
// `signals.getToken` calls up ~50x, enough to saturate the API pool. Each schedule here therefore
// grows exponentially, is capped, and picks a uniformly random delay below its current ceiling
// ("full jitter"), which spreads a fleet that disconnected together across the whole window.

export type BackoffConfig = {
  /** Ceiling of the first delay; each further attempt doubles it until `capMs`. */
  baseMs: number;
  /** Largest ceiling. A client stuck in a long outage retries on average every `capMs / 2`. */
  capMs: number;
  /** Shortest delay, so no client can spin even when `random()` lands near 0. */
  minMs: number;
};

/**
 * Full-jitter exponential backoff: a delay drawn uniformly from `[minMs, min(capMs, baseMs * 2^attempt)]`.
 * `attempt` counts from 0.
 */
export function getBackoffDelay(
  attempt: number,
  { baseMs, capMs, minMs }: BackoffConfig,
  random: () => number = Math.random
) {
  // Clamp the exponent too: 2^attempt overflows to Infinity long before an outage ends.
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 30));
  return Math.round(minMs + random() * Math.max(ceiling - minMs, 0));
}

/**
 * Hub connection attempts, both SignalR's automatic reconnect and the worker's own `start()` retry.
 * The first retry lands within 3s, so a brief blip still recovers quickly; from the 7th consecutive
 * failure on, a browser tries on average every 90s, and at most every 180s.
 */
export const HUB_CONNECT_BACKOFF: BackoffConfig = { baseMs: 3_000, capMs: 180_000, minMs: 500 };

/**
 * How long SignalR's automatic reconnect keeps going before it gives up and the connection closes.
 * Closing hands over to the worker's `start()` retry, which keeps the same cadence (its failure
 * count carries over), and lets the tabs re-check the access token — the one thing an automatic
 * reconnect cannot do, since it reuses whatever token the worker already holds.
 */
export const HUB_RECONNECT_GIVE_UP_MS = 5 * 60_000;

/**
 * A connection only resets the backoff once it has stayed up this long. A hub that accepts the
 * handshake and then drops the connection (e.g. a failing `OnConnectedAsync`, or one that stops
 * answering and hits the client's 30s server timeout) would otherwise reset every client to the
 * first, near-instant step on every cycle — a reconnect loop with no backoff at all. A connection
 * lost sooner counts as one more failure instead. Not covered: a connection that outlives this but
 * never hears from the hub; the worker's staleness check drops that after ~3-4 min, so it cycles at
 * most that often — below this schedule's own steady state.
 */
export const HUB_STABLE_CONNECTION_MS = 60_000;

/**
 * @param priorFailures failures already counted before this reconnect began — e.g. connections that
 *   dropped before they were stable — so repeated short-lived connections keep climbing the schedule.
 */
export function getHubReconnectDelay(
  {
    previousRetryCount,
    elapsedMilliseconds,
  }: Pick<RetryContext, 'previousRetryCount' | 'elapsedMilliseconds'>,
  priorFailures = 0,
  random: () => number = Math.random
): number | null {
  if (elapsedMilliseconds >= HUB_RECONNECT_GIVE_UP_MS) return null;
  return getBackoffDelay(priorFailures + previousRetryCount, HUB_CONNECT_BACKOFF, random);
}

export function createHubReconnectPolicy({
  onRetry,
  priorFailures,
}: {
  /** Called before each delay is computed, so it can update what `priorFailures` returns. */
  onRetry?: (context: RetryContext) => void;
  priorFailures?: () => number;
} = {}): IRetryPolicy {
  return {
    nextRetryDelayInMilliseconds(context) {
      onRetry?.(context);
      return getHubReconnectDelay(context, priorFailures?.() ?? 0);
    },
  };
}

/**
 * Re-fetching the signals access token while the connection stays closed and the tab holds NO token
 * — the degraded `{}` response, or a failed fetch. Without a token no connection is ever attempted,
 * so this is the only way such a tab recovers: ~5-30s after the close, doubling to a 10 min ceiling.
 */
export const TOKEN_REFRESH_BACKOFF: BackoffConfig = {
  baseMs: 30_000,
  capMs: 600_000,
  minMs: 5_000,
};

/**
 * Re-minting a token the tab already holds, while the connection stays closed. The token carries no
 * expiry, so in an ordinary outage re-minting it buys nothing and only adds `signals.getToken` load
 * from every tab; it exists as a slow safety net for a hub that no longer accepts the token (its key
 * ring was lost), which the client cannot tell apart from an outage. First after 5-10 min closed,
 * then doubling to a 1 hour ceiling: ~one call per tab per half hour while an outage lasts.
 */
export const TOKEN_REVALIDATE_BACKOFF: BackoffConfig = {
  baseMs: 600_000,
  capMs: 3_600_000,
  minMs: 300_000,
};

/** React Query `retryDelay` for a failed `signals.getToken`. */
export const TOKEN_FETCH_RETRY_BACKOFF: BackoffConfig = {
  baseMs: 4_000,
  capMs: 60_000,
  minMs: 1_000,
};

/**
 * Runs `run` now, or — once it has failed — no sooner than its backoff allows. Only one attempt is
 * ever pending, so callers asking repeatedly while an outage lasts cannot add attempts.
 */
export class BackoffRetry {
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAttemptAt: number | null = null;

  constructor(
    private readonly run: () => void,
    private readonly config: BackoffConfig,
    // Looked up per call rather than captured, so a stubbed `Math.random` reaches a live instance.
    private readonly random: () => number = () => Math.random()
  ) {}

  /** Attempt now if nothing has failed since the last success; otherwise wait for the schedule. */
  request() {
    if (this.timer) return;
    if (this.failures === 0) this.run();
    else this.schedule();
  }

  failed() {
    this.failures += 1;
    this.schedule();
  }

  succeeded() {
    this.reset();
  }

  /** Count failures seen elsewhere (e.g. by SignalR's own reconnect) without scheduling an attempt. */
  countFailures(count = 1) {
    this.failures += Math.max(count, 0);
  }

  /** Forget the outage: the next `request()` attempts immediately. */
  reset() {
    this.failures = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAttemptAt = null;
  }

  getStatus() {
    return { failures: this.failures, nextAttemptAt: this.nextAttemptAt };
  }

  private schedule() {
    if (this.timer) return;
    const delay = getBackoffDelay(this.failures - 1, this.config, this.random);
    this.nextAttemptAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextAttemptAt = null;
      this.run();
    }, delay);
  }
}
