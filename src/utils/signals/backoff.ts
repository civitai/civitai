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

export function getHubReconnectDelay(
  {
    previousRetryCount,
    elapsedMilliseconds,
  }: Pick<RetryContext, 'previousRetryCount' | 'elapsedMilliseconds'>,
  random: () => number = Math.random
): number | null {
  if (elapsedMilliseconds >= HUB_RECONNECT_GIVE_UP_MS) return null;
  return getBackoffDelay(previousRetryCount, HUB_CONNECT_BACKOFF, random);
}

export function createHubReconnectPolicy(onRetry?: (context: RetryContext) => void): IRetryPolicy {
  return {
    nextRetryDelayInMilliseconds(context) {
      onRetry?.(context);
      return getHubReconnectDelay(context);
    },
  };
}

/**
 * Re-minting the signals access token while the hub is unreachable. The token carries no expiry, so
 * one that has connected stays good across an outage; re-minting exists for a token the hub no longer
 * accepts, and for the degraded `{}` response, which carries no token at all. Neither is urgent
 * enough to justify more than one `signals.getToken` per tab every ~5 min while an outage lasts.
 */
export const TOKEN_REFRESH_BACKOFF: BackoffConfig = {
  baseMs: 30_000,
  capMs: 600_000,
  minMs: 5_000,
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

  /** Never moves the count backwards: a longer outage seen elsewhere keeps its place on the schedule. */
  carryOver(failures: number) {
    this.failures = Math.max(this.failures, failures);
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
