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
 * Every hub `start()` the worker retries — after a failed attempt or a lost connection. The first
 * retry lands within 3s, so a brief blip still recovers quickly; from the 7th consecutive failure
 * on, a browser tries on average every 90s, and at most every 180s.
 */
export const HUB_CONNECT_BACKOFF: BackoffConfig = { baseMs: 3_000, capMs: 180_000, minMs: 500 };

/**
 * A connection only resets the backoff once it has stayed up this long. A hub that accepts the
 * handshake and then drops the connection (e.g. a failing `OnConnectedAsync`, or one that stops
 * answering and hits the client's 30s server timeout) would otherwise put every client back on the
 * first step on every cycle — a reconnect loop that never backs off. A connection lost sooner leaves
 * the count where it was, so the next drop climbs one more step. Not covered: a connection that outlives this but
 * never hears from the hub; the worker's staleness check drops that after ~3-4 min, so it cycles at
 * most that often — below this schedule's own steady state.
 */
export const HUB_STABLE_CONNECTION_MS = 60_000;

/**
 * Re-fetching the signals access token while the tab holds NO token — the degraded `{}` response, or
 * a failed fetch. Without a token no connection is ever attempted, so this is the only way such a tab
 * recovers: ~5-30s, doubling to a 10 min ceiling. A token the tab holds is never re-minted: it does
 * not expire, and a lost connection is retried with it by the worker.
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
